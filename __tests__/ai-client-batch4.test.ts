import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AIVisionCache,
  CostTracker,
  createCache,
  createCostTracker,
  createSmartClient,
} from '../src/ai-client';
import { AIClientFactory } from '../src/ai-client/factory';
import { ImagePreprocessor } from '../src/ai-client/preprocessor';
import { IrisConfig } from '../src/config';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('AI Client Batch 4: Cost Control & Caching', () => {
  describe('AIVisionCache', () => {
    let cache: AIVisionCache;

    beforeEach(() => {
      cache = createCache({ maxMemoryEntries: 3, ttlMs: 5000 });
    });

    afterEach(() => {
      cache.close();
    });

    it('should create cache with default configuration', () => {
      const stats = cache.getStats();
      expect(stats.memorySize).toBe(0);
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
    });

    it('should generate consistent cache keys', () => {
      const key1 = cache.generateKey('hash1', 'hash2', 'openai', 'gpt-4o');
      const key2 = cache.generateKey('hash1', 'hash2', 'openai', 'gpt-4o');
      expect(key1).toBe(key2);
      expect(key1).toBe('openai:gpt-4o:hash1:hash2');
    });

    it('should fold context into the cache key so identical images differ by context', () => {
      const noContext = cache.generateKey('hash1', 'hash2', 'openai', 'gpt-4o');
      const withCtx = cache.generateKey('hash1', 'hash2', 'openai', 'gpt-4o', '{"url":"/a"}');
      const otherCtx = cache.generateKey('hash1', 'hash2', 'openai', 'gpt-4o', '{"url":"/b"}');

      // Empty context keeps the legacy key format (backward compatible)
      expect(noContext).toBe('openai:gpt-4o:hash1:hash2');
      // Non-empty context produces a distinct key per context value
      expect(withCtx).toBe('openai:gpt-4o:hash1:hash2:{"url":"/a"}');
      expect(withCtx).not.toBe(noContext);
      expect(withCtx).not.toBe(otherCtx);
    });

    // Issue #124: a diff-aware verdict and a diff-less one answer different
    // questions, so they must never be served for each other.
    it('should fold the diff hash into the key so diff-aware and diff-less answers never cross-serve', () => {
      const noDiff = cache.generateKey('hash1', 'hash2', 'openai', 'gpt-4o');
      const withDiff = cache.generateKey('hash1', 'hash2', 'openai', 'gpt-4o', '', 'diffhash');
      const otherDiff = cache.generateKey('hash1', 'hash2', 'openai', 'gpt-4o', '', 'diffhash2');

      // Diff-less keys keep the legacy format, so existing cache entries survive.
      expect(noDiff).toBe('openai:gpt-4o:hash1:hash2');
      expect(withDiff).toBe('openai:gpt-4o:hash1:hash2:diff=diffhash');
      expect(withDiff).not.toBe(noDiff);
      expect(withDiff).not.toBe(otherDiff);
    });

    it('should not let a diff hash collide with an identical context string', () => {
      // Without a marker on the diff segment these two would both render as
      // `openai:gpt-4o:hash1:hash2:X` — a diff-aware answer served to a
      // diff-less request that merely carried X as its context.
      const diffOnly = cache.generateKey('hash1', 'hash2', 'openai', 'gpt-4o', '', 'X');
      const contextOnly = cache.generateKey('hash1', 'hash2', 'openai', 'gpt-4o', 'X');
      expect(diffOnly).not.toBe(contextOnly);

      // Both present: each occupies its own labeled segment.
      const both = cache.generateKey('hash1', 'hash2', 'openai', 'gpt-4o', '{"url":"/a"}', 'X');
      expect(both).toBe('openai:gpt-4o:hash1:hash2:diff=X:{"url":"/a"}');
      expect(both).not.toBe(diffOnly);
      expect(both).not.toBe(contextOnly);
    });

    it('should store and retrieve cached results', () => {
      const key = cache.generateKey('baseline', 'current', 'openai', 'gpt-4o');
      const value = {
        severity: 'minor' as const,
        confidence: 0.85,
        reasoning: 'Test change',
        categories: ['color' as const],
      };

      cache.set(key, value, 'openai', 'gpt-4o');
      const retrieved = cache.get(key);

      expect(retrieved).toEqual(value);
      expect(cache.getStats().hits).toBe(1);
      expect(cache.getStats().misses).toBe(0);
    });

    it('should return undefined for cache miss', () => {
      const key = cache.generateKey('unknown', 'unknown', 'openai', 'gpt-4o');
      const result = cache.get(key);

      expect(result).toBeUndefined();
      expect(cache.getStats().misses).toBe(1);
    });

    it('should implement LRU eviction', () => {
      const value = {
        severity: 'none' as const,
        confidence: 1.0,
        reasoning: 'Test',
        categories: [],
      };

      // Fill cache beyond capacity (maxMemoryEntries = 3)
      cache.set(cache.generateKey('1', '1', 'p', 'm'), value, 'p', 'm');
      cache.set(cache.generateKey('2', '2', 'p', 'm'), value, 'p', 'm');
      cache.set(cache.generateKey('3', '3', 'p', 'm'), value, 'p', 'm');
      cache.set(cache.generateKey('4', '4', 'p', 'm'), value, 'p', 'm');

      const stats = cache.getStats();
      expect(stats.memorySize).toBe(3); // Max capacity
      expect(stats.evictions).toBe(1); // One evicted
    });

    it('should track cache hit rate', () => {
      const key = cache.generateKey('test', 'test', 'openai', 'gpt-4o');
      const value = {
        severity: 'none' as const,
        confidence: 1.0,
        reasoning: 'Test',
        categories: [],
      };

      cache.set(key, value, 'openai', 'gpt-4o');
      cache.get(key); // hit
      cache.get(key); // hit
      cache.get('nonexistent'); // miss

      const stats = cache.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBeCloseTo(2 / 3, 2);
    });

    it('should clear all cache entries', () => {
      const value = {
        severity: 'none' as const,
        confidence: 1.0,
        reasoning: 'Test',
        categories: [],
      };

      cache.set(cache.generateKey('1', '1', 'p', 'm'), value, 'p', 'm');
      cache.set(cache.generateKey('2', '2', 'p', 'm'), value, 'p', 'm');

      cache.clear();
      const stats = cache.getStats();

      expect(stats.memorySize).toBe(0);
      expect(stats.persistentSize).toBe(0);
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
    });

    describe('pruning expired entries', () => {
      const value = {
        severity: 'none' as const,
        confidence: 1.0,
        reasoning: 'Test',
        categories: [],
      };

      // Short TTL + a generous sleep (20x margin) keeps these deterministic
      // even on a loaded CI runner.
      const TTL = 10;
      const EXPIRE_WAIT = 200;

      it('removes expired entries when pruneExpired() is called manually', async () => {
        const c = createCache({ ttlMs: TTL });
        c.set(c.generateKey('a', 'a', 'p', 'm'), value, 'p', 'm');
        expect(c.getStats().persistentSize).toBe(1);

        await sleep(EXPIRE_WAIT);
        const removed = c.pruneExpired();

        expect(removed).toBe(1);
        expect(c.getStats().persistentSize).toBe(0);
        c.close();
      });

      it('auto-prunes expired entries once the write throttle is reached', async () => {
        // pruneIntervalWrites = 2 => prune fires on every 2nd set()
        const c = createCache({ ttlMs: TTL, pruneIntervalWrites: 2 });
        c.set(c.generateKey('old', 'old', 'p', 'm'), value, 'p', 'm');

        await sleep(EXPIRE_WAIT); // let the first entry expire

        // 2nd write trips the throttle and prunes the now-expired 'old' entry
        c.set(c.generateKey('fresh', 'fresh', 'p', 'm'), value, 'p', 'm');

        // Persistent SQLite row for the expired entry is reclaimed; only the
        // fresh entry remains. (The in-memory LRU is separately bounded.)
        expect(c.getStats().persistentSize).toBe(1);
        c.close();
      });

      it('prunes expired entries on construction', async () => {
        const dbPath = path.join(os.tmpdir(), `iris-cache-prune-${process.pid}-${Date.now()}.db`);
        let second: AIVisionCache | undefined;
        try {
          const first = createCache({ ttlMs: TTL, dbPath });
          first.set(first.generateKey('a', 'a', 'p', 'm'), value, 'p', 'm');
          expect(first.getStats().persistentSize).toBe(1);
          first.close();

          await sleep(EXPIRE_WAIT); // entry is now expired

          // Reopening the same DB should reclaim the expired row on construction
          second = createCache({ ttlMs: TTL, dbPath });
          expect(second.getStats().persistentSize).toBe(0);
        } finally {
          second?.close();
          for (const suffix of ['', '-wal', '-shm']) {
            fs.rmSync(`${dbPath}${suffix}`, { force: true });
          }
        }
      });
    });
  });

  describe('CostTracker', () => {
    let tracker: CostTracker;

    beforeEach(() => {
      tracker = createCostTracker(':memory:', {
        dailyLimit: 5.0,
        monthlyLimit: 100.0,
      });
    });

    afterEach(() => {
      tracker.close();
    });

    it('should create tracker with default pricing', () => {
      expect(tracker.getPricing('openai', 'gpt-4o')).toBe(0.002);
      expect(tracker.getPricing('anthropic', 'claude-sonnet-5')).toBe(0.0015);
      expect(tracker.getPricing('ollama', 'llava')).toBe(0);
    });

    // Issue #183. These two rows exist for a reason that is invisible from the
    // row itself, so pin them: claude-haiku-4-5 is what the ANTHROPIC_API_KEY
    // env path selects (config.ts:176) and `resolveModel` prefers a configured
    // model over the per-provider default, so it is the model an out-of-the-box
    // user actually requests. Unpriced it computes $0, never accrues against the
    // budget, and the breaker can never trip on the default path — the #126 hole.
    // A later cleanup dropping either row should fail here, not in production.
    it('prices the models the Anthropic defaults actually request (issue #183)', () => {
      expect(tracker.getPricing('anthropic', 'claude-haiku-4-5')).toBe(0.0005);
      expect(tracker.getPricing('anthropic', 'claude-opus-5')).toBe(0.004);
      expect(tracker.isBudgetGated('anthropic', 'claude-haiku-4-5')).toBe(true);
    });

    it('should set custom pricing', () => {
      tracker.setPricing('custom', 'model', 0.005);
      expect(tracker.getPricing('custom', 'model')).toBe(0.005);
    });

    it('should track operation costs', () => {
      const cost = tracker.trackOperation('openai', 'gpt-4o', false);
      expect(cost).toBe(0.002);

      const stats = tracker.getStats();
      expect(stats.totalCost).toBe(0.002);
      expect(stats.operationCount).toBe(1);
    });

    it('should not charge for cached operations', () => {
      tracker.trackOperation('openai', 'gpt-4o', true); // cached
      tracker.trackOperation('openai', 'gpt-4o', true); // cached

      const stats = tracker.getStats();
      expect(stats.totalCost).toBe(0);
      expect(stats.operationCount).toBe(2);
      expect(stats.cacheHitCount).toBe(2);
      expect(stats.cacheHitRate).toBe(1.0);
    });

    it('should calculate budget status', () => {
      // Use 60% of daily budget (3.0 / 5.0)
      for (let i = 0; i < 1500; i++) {
        tracker.trackOperation('openai', 'gpt-4o', false);
      }

      const status = tracker.getBudgetStatus();
      expect(status.dailyPercent).toBeCloseTo(0.6, 1);
      expect(status.warningTriggered).toBe(false); // < 80%
      expect(status.criticalTriggered).toBe(false); // < 95%
      expect(status.circuitBreakerTriggered).toBe(false); // < 100%
    });

    it('should trigger warning at 80%', () => {
      // Use 81% of daily budget (4.05 / 5.0)
      // Each operation costs 0.002, so 2025 operations = 4.05
      for (let i = 0; i < 2025; i++) {
        tracker.trackOperation('openai', 'gpt-4o', false);
      }

      const status = tracker.getBudgetStatus();
      expect(status.dailyPercent).toBeGreaterThan(0.8);
      expect(status.warningTriggered).toBe(true);
      expect(status.criticalTriggered).toBe(false);
    });

    it('should trigger circuit breaker at 100%', () => {
      // Track operations but catch circuit breaker exceptions
      // Each operation costs 0.002, budget is 5.0
      let operations = 0;
      let circuitBreakerHit = false;

      try {
        // Try to exceed budget
        for (let i = 0; i < 3000; i++) {
          tracker.trackOperation('openai', 'gpt-4o', false);
          operations++;
        }
      } catch {
        circuitBreakerHit = true;
      }

      expect(circuitBreakerHit).toBe(true);
      expect(operations).toBeGreaterThan(2400); // Should have tracked most operations

      const status = tracker.getBudgetStatus();
      expect(status.circuitBreakerTriggered).toBe(true);
    });

    // Regression tests for issue #126: a provider:model pair absent from the
    // pricing map resolved to cost 0, which the breaker read as "free". So a
    // real paid model nobody had priced was recorded at $0 AND exempted from
    // enforcement — the budget silently failing open, same family as #132.
    describe('unpriced models (issue #126)', () => {
      it('treats an unknown provider:model as paid, not free', () => {
        // "I have no price for this" and "this is free" are different answers.
        // Only one of them is safe to assume.
        expect(tracker.isBudgetGated('openai', 'some-unreleased-model')).toBe(true);
      });

      it('treats an explicitly zero-priced pair as free', () => {
        // Ollama runs locally. Registered at 0 on purpose, so it must stay exempt
        // (issue #68) — that is what distinguishes it from merely-unknown.
        expect(tracker.isBudgetGated('ollama', 'llava')).toBe(false);
      });

      it('treats a token-rate-only registration as paid', () => {
        // costPerImage 0 with real token rates is a paid model whose per-call
        // price simply is not known before the call.
        tracker.setPricing('custom', 'metered', 0, 1e-6, 2e-6);
        expect(tracker.isBudgetGated('custom', 'metered')).toBe(true);
      });

      it('blocks an unpriced paid model once the breaker has tripped', () => {
        expect(() => {
          for (let i = 0; i < 3000; i++) tracker.trackOperation('openai', 'gpt-4o', false);
        }).toThrow(/circuit breaker/i);

        // The bug: this used to sail through, because its computed cost was 0.
        expect(() => tracker.trackOperation('openai', 'some-unreleased-model', false)).toThrow(
          /Budget limit exceeded/,
        );
      });

      it('still lets cache hits and free providers through after tripping', () => {
        expect(() => {
          for (let i = 0; i < 3000; i++) tracker.trackOperation('openai', 'gpt-4o', false);
        }).toThrow(/circuit breaker/i);

        // Issue #68 must survive this change: neither of these costs anything.
        expect(tracker.trackOperation('openai', 'some-unreleased-model', true)).toBe(0);
        expect(tracker.trackOperation('ollama', 'llava', false)).toBe(0);
      });

      it('warns once per pair when a billable operation records $0', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation();

        tracker.trackOperation('openai', 'some-unreleased-model', false);
        tracker.trackOperation('openai', 'some-unreleased-model', false);
        tracker.trackOperation('openai', 'another-unpriced-model', false);

        // Once per pair, not once per call: a hot loop must not bury the warning
        // it is trying to surface.
        const messages = warn.mock.calls.map((c) => String(c[0]));
        expect(messages.filter((m) => m.includes('some-unreleased-model'))).toHaveLength(1);
        expect(messages.filter((m) => m.includes('another-unpriced-model'))).toHaveLength(1);
        expect(messages[0]).toMatch(/no pricing/i);

        warn.mockRestore();
      });

      it('does not warn for free providers or cache hits', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation();

        tracker.trackOperation('ollama', 'llava', false);
        tracker.trackOperation('openai', 'gpt-4o', true);

        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
      });

      // Review of PR #177 caught that gating per model re-blocked local models
      // that simply were not in DEFAULT_PRICING. #68's exemption is about the
      // PROVIDER: Ollama runs locally, so every model on it is free.
      it('exempts any model on a free provider, not just the pre-registered ones', () => {
        expect(tracker.isBudgetGated('ollama', 'moondream')).toBe(false);
        expect(tracker.isBudgetGated('ollama', 'llava')).toBe(false);
        expect(tracker.isBudgetGated('OLLAMA', 'anything-at-all')).toBe(false);
      });

      it('lets an unregistered local model through after the breaker has tripped', () => {
        expect(() => {
          for (let i = 0; i < 3000; i++) tracker.trackOperation('openai', 'gpt-4o', false);
        }).toThrow(/circuit breaker/i);

        // Would have been blocked by the first version of this fix.
        expect(tracker.trackOperation('ollama', 'moondream', false)).toBe(0);
      });

      it('does not warn about a local model on a free provider', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation();
        tracker.trackOperation('ollama', 'moondream', false);
        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
      });

      it('does not claim "no pricing" for a token-rate model called without usage', () => {
        // It IS registered. The $0 here comes from the provider not reporting
        // usage, so telling the user to call setPricing() would misdiagnose it.
        tracker.setPricing('custom', 'metered', 0, 1e-6, 2e-6);
        const warn = jest.spyOn(console, 'warn').mockImplementation();

        tracker.trackOperation('custom', 'metered', false); // no usage supplied

        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
      });

      it('prices gpt-4o-mini, which is the configured default model', () => {
        // config.ts defaults ai.model to gpt-4o-mini, so the out-of-the-box
        // model was the one going unpriced.
        expect(tracker.getPricing('openai', 'gpt-4o-mini')).toBeGreaterThan(0);
        expect(tracker.isBudgetGated('openai', 'gpt-4o-mini')).toBe(true);
      });
    });

    // Regression tests for issue #132: the budget getters bounded their sum at
    // Date.now(). A backward clock jump (NTP correction, VM/WSL suspend-resume)
    // makes every already-written row future-dated, so recorded spend vanishes
    // from the sum and the breaker never arms — unbounded overspend until the
    // clock catches up. Observed for real on WSL2, and it flaked the breaker
    // test above roughly 1-in-40 runs.
    describe('backward clock movement (issue #132)', () => {
      // Mid-day, so shifting by seconds cannot cross a day/month boundary and
      // change which period we are asking about.
      const noon = new Date('2026-07-25T12:00:00.000Z').getTime();

      /**
       * Record spend "in the future", then put the clock back where it was.
       *
       * The breaker tripping *during* the loop is expected and correct — while
       * the clock is ahead it is self-consistent, so the sum is right. The bug
       * only appears once the clock moves back, which is what we assert after.
       */
      const trackWithClockAhead = (aheadMs: number, operations: number) => {
        const spy = jest.spyOn(Date, 'now').mockReturnValue(noon + aheadMs);
        try {
          for (let i = 0; i < operations; i++) {
            try {
              tracker.trackOperation('openai', 'gpt-4o', false);
            } catch {
              break; // budget reached; enough spend is on the books
            }
          }
        } finally {
          spy.mockReturnValue(noon); // the clock jumps back
        }
      };

      afterEach(() => {
        jest.restoreAllMocks();
      });

      it('still counts spend recorded ahead of the current clock', () => {
        trackWithClockAhead(10_000, 1000); // 1000 * 0.002 = $2.00

        // Bounding at Date.now() returned 0 here: every row was 10s in the future.
        expect(tracker.getDailyCost()).toBeCloseTo(2.0, 5);
        expect(tracker.getMonthlyCost()).toBeCloseTo(2.0, 5);
      });

      it('still arms the circuit breaker on spend recorded ahead of the clock', () => {
        // $5.00/day limit; 2600 operations = $5.20, comfortably over.
        trackWithClockAhead(10_000, 2600);

        const status = tracker.getBudgetStatus();
        expect(status.dailyPercent).toBeGreaterThanOrEqual(1.0);
        expect(status.circuitBreakerTriggered).toBe(true);
        // And the breaker actually blocks the next paid operation.
        expect(() => tracker.trackOperation('openai', 'gpt-4o', false)).toThrow();
      });

      it('leaves getCostForPeriod range queries bounded as before', () => {
        // The fix is scoped to the budget getters. Explicit reporting ranges
        // must still exclude what falls outside them, or range queries become
        // meaningless.
        trackWithClockAhead(10_000, 500);

        expect(tracker.getCostForPeriod(noon - 60_000, noon)).toBe(0);
        expect(tracker.getCostForPeriod(noon - 60_000, noon + 60_000)).toBeCloseTo(1.0, 5);
      });
    });

    // Regression tests for issue #68: the breaker must block only paid
    // operations — $0 cache hits and free providers always proceed.
    describe('circuit breaker with free operations (issue #68)', () => {
      const tripBreaker = () => {
        expect(() => {
          for (let i = 0; i < 3000; i++) {
            tracker.trackOperation('openai', 'gpt-4o', false);
          }
        }).toThrow(/circuit breaker/i);
        expect(tracker.getBudgetStatus().circuitBreakerTriggered).toBe(true);
      };

      it('allows cached operations after the breaker has tripped', () => {
        tripBreaker();
        expect(tracker.trackOperation('openai', 'gpt-4o', true)).toBe(0);
      });

      it('allows free-provider (ollama) operations after the breaker has tripped', () => {
        tripBreaker();
        expect(tracker.trackOperation('ollama', 'llava', false)).toBe(0);
      });

      it('still blocks paid operations after the breaker has tripped', () => {
        tripBreaker();
        expect(() => tracker.trackOperation('openai', 'gpt-4o', false)).toThrow(
          /Budget limit exceeded/,
        );
      });
    });

    it('should track cost by provider and model', () => {
      tracker.trackOperation('openai', 'gpt-4o', false);
      tracker.trackOperation('anthropic', 'claude-sonnet-5', false);
      tracker.trackOperation('ollama', 'llava', false);

      const stats = tracker.getStats();
      expect(stats.costByProvider['openai']).toBe(0.002);
      expect(stats.costByProvider['anthropic']).toBe(0.0015);
      expect(stats.costByProvider['ollama']).toBe(0);
    });

    describe('token-based cost accounting (issue #67)', () => {
      it('should compute cost from token usage for a high-detail gpt-4o image', () => {
        // A 1024x1024 high-detail image ≈ 765 input tokens; add a realistic
        // completion. gpt-4o rates: $2.50/1M in, $10/1M out.
        const cost = tracker.trackOperation('openai', 'gpt-4o', false, {
          inputTokens: 765,
          outputTokens: 234,
        });
        const expected = 765 * 2.5e-6 + 234 * 1e-5;
        expect(cost).toBeCloseTo(expected, 10);
        // The token-based cost must differ from the old flat per-image estimate,
        // otherwise the budget under-counting bug would persist.
        expect(cost).not.toBeCloseTo(0.002, 6);
      });

      it('should compute cost from token usage for anthropic', () => {
        // claude-sonnet-5 rates: $3/1M in, $15/1M out.
        const cost = tracker.trackOperation('anthropic', 'claude-sonnet-5', false, {
          inputTokens: 1000,
          outputTokens: 200,
        });
        expect(cost).toBeCloseTo(1000 * 3e-6 + 200 * 1.5e-5, 10);
      });

      it('should fall back to per-image price when usage is not provided', () => {
        const cost = tracker.trackOperation('openai', 'gpt-4o', false);
        expect(cost).toBe(0.002);
      });

      it('should fall back to per-image price when the model has no token rates', () => {
        // gpt-4-vision-preview has only a per-image price configured.
        const cost = tracker.trackOperation('openai', 'gpt-4-vision-preview', false, {
          inputTokens: 500,
          outputTokens: 100,
        });
        expect(cost).toBe(0.003);
      });

      it('should keep cached operations free even when usage is supplied', () => {
        const cost = tracker.trackOperation('openai', 'gpt-4o', true, {
          inputTokens: 765,
          outputTokens: 234,
        });
        expect(cost).toBe(0);
      });

      it('should accumulate token-based cost into budget status', () => {
        // Enough high-detail calls to exceed 80% of the $5 daily budget. The old
        // flat estimate (0.002/call) would have counted only ~0.85 here — well
        // under warning — so this exercises the under-counting the bug caused.
        const perCall = 2000 * 2.5e-6 + 500 * 1e-5; // = 0.01
        const calls = Math.ceil((5.0 * 0.85) / perCall);
        for (let i = 0; i < calls; i++) {
          tracker.trackOperation('openai', 'gpt-4o', false, {
            inputTokens: 2000,
            outputTokens: 500,
          });
        }
        const status = tracker.getBudgetStatus();
        // Warning fires on token-based spend, which the flat estimate never
        // would here (425 * 0.002 = 0.85, far below the 80% = $4.0 threshold).
        expect(status.warningTriggered).toBe(true);
        // Inclusive upper bound (getCostForPeriod uses <=) means same-millisecond
        // rows are no longer dropped, so the full recorded spend is counted.
        expect(status.dailyUsed).toBeCloseTo(calls * perCall, 6);
      });

      it('should clear stale token rates when pricing is overridden with flat-only', () => {
        // Override gpt-4o with a flat-only price; token rates must be dropped so
        // the new per-image price wins even when usage is supplied.
        tracker.setPricing('openai', 'gpt-4o', 0.05);
        const cost = tracker.trackOperation('openai', 'gpt-4o', false, {
          inputTokens: 765,
          outputTokens: 234,
        });
        expect(cost).toBe(0.05);
      });

      it('should fall back to per-image price when usage is invalid', () => {
        // Negative and non-finite counts must not corrupt recorded cost.
        for (const bad of [
          { inputTokens: -5, outputTokens: 100 },
          { inputTokens: 100, outputTokens: NaN },
          { inputTokens: Infinity, outputTokens: 10 },
          // All-zero usage would record a real API call as free — treat as
          // "no usage" and fall back rather than under-count (issue #67).
          { inputTokens: 0, outputTokens: 0 },
        ]) {
          expect(tracker.trackOperation('openai', 'gpt-4o', false, bad)).toBe(0.002);
        }
      });
    });
  });

  describe('SmartAIVisionClient', () => {
    const mockConfig: IrisConfig = {
      ai: {
        provider: 'ollama',
        endpoint: 'http://localhost:11434',
        model: 'llava',
      },
      watch: { patterns: [], debounceMs: 1000, ignore: [] },
      browser: { headless: true, timeout: 30000 },
    };

    it('should create smart client with default configuration', () => {
      const client = createSmartClient(mockConfig, {
        cacheConfig: { dbPath: ':memory:' },
        costConfig: { dbPath: ':memory:' },
      });
      expect(client).toBeDefined();

      const cacheStats = client.getCacheStats();
      expect(cacheStats?.memorySize).toBe(0);

      const costStats = client.getCostStats();
      expect(costStats?.totalCost).toBe(0);

      client.close();
    });

    it('should return budget status', () => {
      const client = createSmartClient(mockConfig, {
        cacheConfig: { dbPath: ':memory:' },
        costConfig: { dbPath: ':memory:', dailyLimit: 10, monthlyLimit: 200 },
      });

      const status = client.getBudgetStatus();
      expect(status).toBeDefined();
      expect(status?.dailyLimit).toBe(10);
      expect(status?.monthlyLimit).toBe(200);

      client.close();
    });

    it('should create with custom configuration', () => {
      const client = createSmartClient(mockConfig, {
        enableCache: true,
        enableCostTracking: true,
        enableFallback: false,
        cacheConfig: { dbPath: ':memory:', maxMemoryEntries: 50 },
        costConfig: { dbPath: ':memory:', dailyLimit: 20 },
      });

      expect(client).toBeDefined();
      client.close();
    });

    // Regression test for issue #60 (P0.7): cache read/write keys must stay in
    // sync so a repeated identical request hits cache and issues no second API
    // call. Uses the configured provider/model (gpt-4o-mini) — not the hardcoded
    // per-provider default (gpt-4o) — to prove irisConfig.ai.model is honored.
    it('should serve a repeated request from cache without a second API call', async () => {
      const analyzeSpy = jest.fn().mockResolvedValue({
        severity: 'minor',
        confidence: 0.9,
        reasoning: 'Cached-path change',
        categories: ['color'],
      });
      const fakeClient = {
        analyzeVisualDiff: analyzeSpy,
        isAvailable: jest.fn().mockResolvedValue(true),
      };
      const factorySpy = jest.spyOn(AIClientFactory, 'create').mockReturnValue(fakeClient as never);
      const preprocessSpy = jest
        .spyOn(ImagePreprocessor.prototype, 'preprocess')
        .mockImplementation(async (input) =>
          Promise.resolve({
            buffer: Buffer.isBuffer(input) ? input : Buffer.from(String(input)),
            hash: Buffer.isBuffer(input) ? input.toString('hex') : String(input),
            base64: '',
            format: 'jpeg',
            width: 1,
            height: 1,
            originalSize: 1,
            processedSize: 1,
          } as never),
        );

      const client = createSmartClient(
        { ...mockConfig, ai: { ...mockConfig.ai, provider: 'openai', model: 'gpt-4o-mini' } },
        {
          enableFallback: false,
          cacheConfig: { dbPath: ':memory:' },
          costConfig: { dbPath: ':memory:' },
        },
      );

      const request = { baseline: Buffer.from('base'), current: Buffer.from('curr') };

      const first = await client.analyzeVisualDiff(request);
      const second = await client.analyzeVisualDiff(request);

      expect(first).toEqual(second);
      expect(analyzeSpy).toHaveBeenCalledTimes(1); // second call served from cache

      const cacheStats = client.getCacheStats();
      expect(cacheStats?.hits).toBe(1);
      expect(cacheStats?.misses).toBe(1);

      client.close();
      factorySpy.mockRestore();
      preprocessSpy.mockRestore();
    });

    // Bypass sharp: give every preprocess a deterministic hash/buffer.
    const stubPreprocess = () =>
      jest.spyOn(ImagePreprocessor.prototype, 'preprocess').mockImplementation(async (input) =>
        Promise.resolve({
          buffer: Buffer.isBuffer(input) ? input : Buffer.from(String(input)),
          hash: Buffer.isBuffer(input) ? input.toString('hex') : String(input),
          base64: '',
          format: 'jpeg',
          width: 1,
          height: 1,
          originalSize: 1,
          processedSize: 1,
        } as never),
      );

    // Issue #124. Two things have to hold at once here: the diff buffer must
    // survive the smart client's field-by-field rebuild of the provider request
    // (it is the second place the diff used to be dropped), and it must change
    // the cache identity so a diff-less request cannot be answered from a
    // diff-aware entry.
    it('preprocesses the diff image, forwards it to the provider, and keys the cache on it', async () => {
      const preprocessSpy = stubPreprocess();
      const analyzeSpy = jest.fn().mockResolvedValue({
        severity: 'minor',
        confidence: 0.9,
        reasoning: 'Diff-aware verdict',
        categories: ['color'],
      });
      const fakeClient = {
        analyzeVisualDiff: analyzeSpy,
        isAvailable: jest.fn().mockResolvedValue(true),
      };
      const factorySpy = jest.spyOn(AIClientFactory, 'create').mockReturnValue(fakeClient as never);

      const client = createSmartClient(
        { ...mockConfig, ai: { ...mockConfig.ai, provider: 'openai', model: 'gpt-4o-mini' } },
        {
          enableFallback: false,
          cacheConfig: { dbPath: ':memory:' },
          costConfig: { dbPath: ':memory:' },
        },
      );

      const baseline = Buffer.from('base');
      const current = Buffer.from('curr');
      const diff = Buffer.from('diffmask');

      await client.analyzeVisualDiff({ baseline, current, diff });

      expect(preprocessSpy).toHaveBeenCalledWith(diff);
      expect(analyzeSpy.mock.calls[0][0].diff).toEqual(diff);

      // Same screenshots, no diff: a distinct cache identity, so a real call.
      await client.analyzeVisualDiff({ baseline, current });
      expect(analyzeSpy).toHaveBeenCalledTimes(2);
      expect(analyzeSpy.mock.calls[1][0].diff).toBeUndefined();

      // Repeating the diff-aware request is served from cache.
      await client.analyzeVisualDiff({ baseline, current, diff });
      expect(analyzeSpy).toHaveBeenCalledTimes(2);

      client.close();
      factorySpy.mockRestore();
      preprocessSpy.mockRestore();
    });

    // Regression for the cross-family review of #124. The diff mask is a
    // signal, not a photo: pixelmatch marks unchanged pixels TRANSPARENT, and
    // the default preprocessor re-encodes to JPEG — which has no alpha channel
    // and blurs hard edges into its 8x8 blocks. That yields a plausible-looking
    // three-image payload carrying no localization, which is the whole point of
    // sending it. Real sharp on purpose: a stubbed preprocessor hands back
    // whatever buffer it was given and can never catch this.
    it('sends the diff mask losslessly as PNG with its alpha channel intact', async () => {
      const sharp = (await import('sharp')).default;
      const mask = await sharp({
        create: {
          width: 40,
          height: 40,
          channels: 4,
          background: { r: 255, g: 0, b: 0, alpha: 0 },
        },
      })
        .png()
        .toBuffer();
      const screenshot = await sharp({
        create: { width: 40, height: 40, channels: 3, background: { r: 10, g: 20, b: 30 } },
      })
        .png()
        .toBuffer();

      const analyzeSpy = jest.fn().mockResolvedValue({
        severity: 'minor',
        confidence: 0.9,
        reasoning: 'r',
        categories: ['color'],
      });
      const factorySpy = jest.spyOn(AIClientFactory, 'create').mockReturnValue({
        analyzeVisualDiff: analyzeSpy,
        isAvailable: jest.fn().mockResolvedValue(true),
      } as never);

      const client = createSmartClient(
        { ...mockConfig, ai: { ...mockConfig.ai, provider: 'openai', model: 'gpt-4o-mini' } },
        {
          enableFallback: false,
          cacheConfig: { dbPath: ':memory:' },
          costConfig: { dbPath: ':memory:' },
        },
      );

      await client.analyzeVisualDiff({ baseline: screenshot, current: screenshot, diff: mask });

      const sent = analyzeSpy.mock.calls[0][0];
      const diffMeta = await sharp(sent.diff).metadata();
      expect(diffMeta.format).toBe('png');
      expect(diffMeta.hasAlpha).toBe(true);

      // The two screenshots keep their existing lossy treatment — this must not
      // have turned into a blanket "everything is PNG now" change.
      expect((await sharp(sent.baseline).metadata()).format).toBe('jpeg');

      client.close();
      factorySpy.mockRestore();
    });

    it('treats an empty diff buffer as no diff rather than failing the analysis', async () => {
      const sharp = (await import('sharp')).default;
      const screenshot = await sharp({
        create: { width: 20, height: 20, channels: 3, background: { r: 1, g: 2, b: 3 } },
      })
        .png()
        .toBuffer();

      const analyzeSpy = jest.fn().mockResolvedValue({
        severity: 'none',
        confidence: 1,
        reasoning: 'r',
        categories: [],
      });
      const factorySpy = jest.spyOn(AIClientFactory, 'create').mockReturnValue({
        analyzeVisualDiff: analyzeSpy,
        isAvailable: jest.fn().mockResolvedValue(true),
      } as never);

      const client = createSmartClient(
        { ...mockConfig, ai: { ...mockConfig.ai, provider: 'openai', model: 'gpt-4o-mini' } },
        {
          enableFallback: false,
          cacheConfig: { dbPath: ':memory:' },
          costConfig: { dbPath: ':memory:' },
        },
      );

      // Zero bytes carry no signal, and sharp throws on them — degrading to the
      // two-image request beats failing the whole analysis.
      await expect(
        client.analyzeVisualDiff({
          baseline: screenshot,
          current: screenshot,
          diff: Buffer.alloc(0),
        }),
      ).resolves.toBeDefined();
      expect(analyzeSpy.mock.calls[0][0].diff).toBeUndefined();

      client.close();
      factorySpy.mockRestore();
    });

    it('advances past a failing provider to the next in the fallback chain', async () => {
      const preprocessSpy = stubPreprocess();
      const ollamaClient = {
        analyzeVisualDiff: jest.fn().mockRejectedValue(new Error('ollama down')),
        isAvailable: jest.fn().mockResolvedValue(true),
      };
      const openaiResult = {
        severity: 'minor' as const,
        confidence: 0.8,
        reasoning: 'from openai',
        categories: ['color' as const],
      };
      const openaiClient = {
        analyzeVisualDiff: jest.fn().mockResolvedValue(openaiResult),
        isAvailable: jest.fn().mockResolvedValue(true),
      };
      const factorySpy = jest
        .spyOn(AIClientFactory, 'create')
        .mockImplementation(
          (cfg: IrisConfig) =>
            (cfg.ai.provider === 'ollama' ? ollamaClient : openaiClient) as never,
        );

      const client = createSmartClient(mockConfig, {
        enableFallback: true,
        fallbackChain: ['ollama', 'openai', 'anthropic'],
        cacheConfig: { dbPath: ':memory:' },
        costConfig: { dbPath: ':memory:' },
      });

      const result = await client.analyzeVisualDiff({
        baseline: Buffer.from('b'),
        current: Buffer.from('c'),
      });

      expect(result).toEqual(openaiResult);
      expect(ollamaClient.analyzeVisualDiff).toHaveBeenCalledTimes(1); // tried and failed
      expect(openaiClient.analyzeVisualDiff).toHaveBeenCalledTimes(1); // succeeded

      client.close();
      factorySpy.mockRestore();
      preprocessSpy.mockRestore();
    });

    it('throws when the budget circuit breaker is tripped (no API call made)', async () => {
      const preprocessSpy = stubPreprocess();
      const fakeClient = {
        analyzeVisualDiff: jest.fn(),
        isAvailable: jest.fn().mockResolvedValue(true),
      };
      const factorySpy = jest.spyOn(AIClientFactory, 'create').mockReturnValue(fakeClient as never);
      const budgetSpy = jest
        .spyOn(CostTracker.prototype, 'getBudgetStatus')
        .mockReturnValue({ circuitBreakerTriggered: true } as never);

      // Paid provider+model: the pre-attempt breaker check only applies when
      // getPricing(...) > 0 (issue #68), so 'gpt-4o' must be explicit here.
      const client = createSmartClient(
        { ...mockConfig, ai: { ...mockConfig.ai, provider: 'openai', model: 'gpt-4o' } },
        {
          enableFallback: false,
          cacheConfig: { dbPath: ':memory:' },
          costConfig: { dbPath: ':memory:' },
        },
      );

      await expect(
        client.analyzeVisualDiff({ baseline: Buffer.from('b'), current: Buffer.from('c') }),
      ).rejects.toThrow(/circuit breaker activated/i);
      expect(fakeClient.analyzeVisualDiff).not.toHaveBeenCalled();

      client.close();
      factorySpy.mockRestore();
      budgetSpy.mockRestore();
      preprocessSpy.mockRestore();
    });

    // Issue #68: a cache hit is free, so an exhausted budget must not turn a
    // correct cached answer into a thrown error.
    it('serves a cache hit even after the budget is exhausted', async () => {
      const preprocessSpy = stubPreprocess();
      const result = {
        severity: 'minor' as const,
        confidence: 0.9,
        reasoning: 'cached under exhausted budget',
        categories: ['color' as const],
      };
      const fakeClient = {
        analyzeVisualDiff: jest.fn().mockResolvedValue(result),
        isAvailable: jest.fn().mockResolvedValue(true),
      };
      const factorySpy = jest.spyOn(AIClientFactory, 'create').mockReturnValue(fakeClient as never);

      // Daily limit below one gpt-4o call: the first (paid) call exhausts the
      // budget, so the second call runs with the breaker genuinely tripped.
      const client = createSmartClient(
        { ...mockConfig, ai: { ...mockConfig.ai, provider: 'openai', model: 'gpt-4o' } },
        {
          enableFallback: false,
          cacheConfig: { dbPath: ':memory:' },
          costConfig: { dbPath: ':memory:', dailyLimit: 0.001, monthlyLimit: 0.001 },
        },
      );

      const request = { baseline: Buffer.from('b'), current: Buffer.from('c') };
      const first = await client.analyzeVisualDiff(request);
      expect(client.getBudgetStatus()?.circuitBreakerTriggered).toBe(true);

      const second = await client.analyzeVisualDiff(request);
      expect(second).toEqual(first);
      expect(fakeClient.analyzeVisualDiff).toHaveBeenCalledTimes(1); // cache hit, no API call

      client.close();
      factorySpy.mockRestore();
      preprocessSpy.mockRestore();
    });

    // Issue #68: the pre-attempt breaker check only applies to paid providers —
    // free local Ollama proceeds even when the budget is exhausted.
    it('lets free Ollama calls through when the budget is exhausted', async () => {
      const preprocessSpy = stubPreprocess();
      const result = {
        severity: 'minor' as const,
        confidence: 0.8,
        reasoning: 'ollama under exhausted budget',
        categories: ['layout' as const],
      };
      const fakeClient = {
        analyzeVisualDiff: jest.fn().mockResolvedValue(result),
        isAvailable: jest.fn().mockResolvedValue(true),
      };
      const factorySpy = jest.spyOn(AIClientFactory, 'create').mockReturnValue(fakeClient as never);
      const budgetSpy = jest
        .spyOn(CostTracker.prototype, 'getBudgetStatus')
        .mockReturnValue({ circuitBreakerTriggered: true } as never);

      const client = createSmartClient(mockConfig, {
        enableFallback: false,
        cacheConfig: { dbPath: ':memory:' },
        costConfig: { dbPath: ':memory:' },
      });

      await expect(
        client.analyzeVisualDiff({ baseline: Buffer.from('b'), current: Buffer.from('c') }),
      ).resolves.toEqual(result);
      expect(fakeClient.analyzeVisualDiff).toHaveBeenCalledTimes(1);

      client.close();
      factorySpy.mockRestore();
      budgetSpy.mockRestore();
      preprocessSpy.mockRestore();
    });
  });

  describe('Integration: Cache + Cost Tracker + Smart Client', () => {
    it('should work together for cost optimization', () => {
      const cache = createCache({ maxMemoryEntries: 10 });
      const tracker = createCostTracker(':memory:', {
        dailyLimit: 1.0,
        monthlyLimit: 20.0,
      });

      // Simulate operations
      const key1 = cache.generateKey('hash1', 'hash2', 'openai', 'gpt-4o');
      const result = {
        severity: 'minor' as const,
        confidence: 0.8,
        reasoning: 'Test',
        categories: [],
      };

      // First operation - cache miss, track cost
      let cached = cache.get(key1);
      if (!cached) {
        tracker.trackOperation('openai', 'gpt-4o', false);
        cache.set(key1, result, 'openai', 'gpt-4o');
      }

      // Second operation - cache hit, no cost
      cached = cache.get(key1);
      if (cached) {
        tracker.trackOperation('openai', 'gpt-4o', true);
      }

      const cacheStats = cache.getStats();
      const costStats = tracker.getStats();

      expect(cacheStats.hits).toBe(1);
      expect(cacheStats.misses).toBe(1);
      expect(cacheStats.hitRate).toBe(0.5);
      expect(costStats.operationCount).toBe(2);
      expect(costStats.cacheHitCount).toBe(1);
      expect(costStats.totalCost).toBe(0.002); // Only charged once

      cache.close();
      tracker.close();
    });
  });

  // Security regression guard: the fallback chain steps across vendors, so a
  // wholesale config spread would attach the configured provider's key to every
  // other provider's client — an Anthropic user falling back through OpenAI would
  // transmit `Authorization: Bearer sk-ant-...` to api.openai.com. This path was
  // dormant until #111 made `visual-diff --semantic` reachable. See #74.
  describe('cross-provider credential isolation', () => {
    const irisConfig: IrisConfig = {
      ai: { provider: 'anthropic', apiKey: 'sk-ant-secret', model: 'claude-sonnet-5' },
      watch: { patterns: [], debounceMs: 1000, ignore: [] },
      browser: { headless: true, timeout: 30000 },
    };
    // Cache/cost tracking off so the test opens no SQLite files.
    const smartOpts = { enableCache: false, enableCostTracking: false };

    // getClient is private; exercised directly because the leak happens at client
    // construction, before any request is issued.
    const clientFor = (smart: unknown, provider: string) =>
      (smart as { getClient(p: string): { config: { apiKey?: string; endpoint?: string } } })[
        'getClient'
      ](provider);

    it('never forwards the configured key to a different provider', () => {
      const smart = createSmartClient(irisConfig, smartOpts);

      expect(clientFor(smart, 'openai').config.apiKey).toBeUndefined();
      expect(clientFor(smart, 'ollama').config.apiKey).toBeUndefined();
      // ...while the provider it was actually configured for still gets it.
      expect(clientFor(smart, 'anthropic').config.apiKey).toBe('sk-ant-secret');
    });

    it('reports a credential-less provider as unavailable so it is skipped, not called', async () => {
      const smart = createSmartClient(irisConfig, smartOpts);
      const openai = clientFor(smart, 'openai') as unknown as {
        isAvailable(): Promise<boolean>;
      };

      // isAvailable() === false is what keeps the request from ever being sent.
      await expect(openai.isAvailable()).resolves.toBe(false);
    });

    it('does not leak a configured endpoint to another provider', () => {
      const smart = createSmartClient(
        { ...irisConfig, ai: { ...irisConfig.ai, endpoint: 'https://proxy.internal/v1' } },
        smartOpts,
      );

      expect(clientFor(smart, 'ollama').config.endpoint).toBeUndefined();
    });

    // The other half of #74: isolation alone leaves every non-configured provider
    // credential-less, so the advertised Ollama -> OpenAI -> Anthropic chain can
    // never actually cross clouds. A per-provider credentials map is what makes
    // the fallback real rather than merely safe.
    describe('per-provider credentials enable real cross-cloud fallback', () => {
      const withCredentials: IrisConfig = {
        ...irisConfig,
        ai: {
          ...irisConfig.ai,
          credentials: {
            openai: { apiKey: 'sk-openai-key' },
            anthropic: { apiKey: 'sk-ant-secret' },
            ollama: { endpoint: 'http://localhost:11434' },
          },
        },
      };

      it('gives each provider its own key', () => {
        const smart = createSmartClient(withCredentials, smartOpts);

        expect(clientFor(smart, 'openai').config.apiKey).toBe('sk-openai-key');
        expect(clientFor(smart, 'anthropic').config.apiKey).toBe('sk-ant-secret');
        expect(clientFor(smart, 'ollama').config.endpoint).toBe('http://localhost:11434');
      });

      it('still keeps keys from crossing vendors', () => {
        const smart = createSmartClient(withCredentials, smartOpts);

        expect(clientFor(smart, 'openai').config.apiKey).not.toBe('sk-ant-secret');
        expect(clientFor(smart, 'ollama').config.apiKey).toBeUndefined();
      });

      it('makes a non-configured provider available so the chain can reach it', async () => {
        const smart = createSmartClient(withCredentials, smartOpts);
        const openai = clientFor(smart, 'openai') as unknown as {
          isAvailable(): Promise<boolean>;
        };

        // Previously false — which is exactly why fallback stopped at the one
        // configured cloud provider.
        await expect(openai.isAvailable()).resolves.toBe(true);
      });

      it('falls back to the top-level key for the configured provider when unmapped', () => {
        const smart = createSmartClient(irisConfig, smartOpts);

        // No credentials map at all: prior behaviour is preserved exactly.
        expect(clientFor(smart, 'anthropic').config.apiKey).toBe('sk-ant-secret');
        expect(clientFor(smart, 'openai').config.apiKey).toBeUndefined();
      });
    });
  });

  // Issue #111: better-sqlite3 refuses to create missing directories, so both of
  // these threw "Cannot open database because the directory does not exist" for
  // any user whose configured DB directory did not already exist — which made
  // `visual-diff --semantic` crash 100% of the time even once a key was wired.
  describe('database directory creation', () => {
    let tmpRoot: string;

    beforeEach(() => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-dbdir-'));
    });

    afterEach(() => {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('creates the parent directory for the vision cache', () => {
      const dbPath = path.join(tmpRoot, 'nested', 'cache', 'vision-cache.db');

      const cache = new AIVisionCache({ dbPath });

      expect(fs.existsSync(path.dirname(dbPath))).toBe(true);
      cache.close();
    });

    it('creates the parent directory for the cost tracker', () => {
      const dbPath = path.join(tmpRoot, 'nested', 'cache', 'cost-tracking.db');

      const tracker = new CostTracker(dbPath);

      expect(fs.existsSync(path.dirname(dbPath))).toBe(true);
      tracker.close();
    });

    // No test asserts the `dbPath !== ':memory:'` guard in ensureDatabaseDir:
    // path.dirname(':memory:') is '.', which always exists, so the !existsSync
    // check already short-circuits and any such test would pass with the guard
    // removed. The guard is retained as intent-documentation (mirroring the
    // original in src/db.ts); ':memory:' behavior is covered throughout this file.
  });
});
