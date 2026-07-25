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
      expect(tracker.getPricing('anthropic', 'claude-3-5-sonnet-20241022')).toBe(0.0015);
      expect(tracker.getPricing('ollama', 'llava')).toBe(0);
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
      tracker.trackOperation('anthropic', 'claude-3-5-sonnet-20241022', false);
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
        // claude-3-5-sonnet rates: $3/1M in, $15/1M out.
        const cost = tracker.trackOperation('anthropic', 'claude-3-5-sonnet-20241022', false, {
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

    it('leaves in-memory databases alone', () => {
      const cache = new AIVisionCache({ dbPath: ':memory:' });
      const tracker = new CostTracker(':memory:');

      // ':memory:' has no real parent dir; the guard must not create a literal one.
      expect(fs.existsSync(path.resolve('.'))).toBe(true);
      expect(fs.existsSync(':memory:')).toBe(false);

      cache.close();
      tracker.close();
    });
  });
});
