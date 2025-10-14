import {
  AIVisionCache,
  CostTracker,
  SmartAIVisionClient,
  createCache,
  createCostTracker,
  createSmartClient,
} from '../src/ai-client';
import { IrisConfig } from '../src/config';

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
      } catch (error) {
        circuitBreakerHit = true;
      }

      expect(circuitBreakerHit).toBe(true);
      expect(operations).toBeGreaterThan(2400); // Should have tracked most operations

      const status = tracker.getBudgetStatus();
      expect(status.circuitBreakerTriggered).toBe(true);
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
});
