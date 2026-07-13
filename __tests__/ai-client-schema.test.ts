/**
 * Tests for vision response schema validation (issue #66).
 *
 * Covers the acceptance criteria:
 * - out-of-schema / empty severity is rejected (no false-clean severity:'none')
 * - confidence is clamped to [0,1] and a legitimate 0 is preserved
 * - non-whitelisted categories are dropped
 * - corrupt cached entries are treated as a miss
 */

import { AIVisionResponseSchema } from '../src/ai-client/types';
import { AIVisionCache } from '../src/ai-client/cache';
import { OllamaVisionClient } from '../src/ai-client/vision';
import { AIVisionResponse } from '../src/ai-client/base';
import { IrisConfig } from '../src/config';

describe('AIVisionResponseSchema normalization', () => {
  const base = { severity: 'minor', reasoning: 'changed', categories: [] };

  it('clamps out-of-range confidence into [0,1]', () => {
    expect(AIVisionResponseSchema.parse({ ...base, confidence: 5 }).confidence).toBe(1);
    expect(AIVisionResponseSchema.parse({ ...base, confidence: -2 }).confidence).toBe(0);
  });

  it('preserves a legitimate confidence of 0 (not overwritten to 0.5)', () => {
    expect(AIVisionResponseSchema.parse({ ...base, confidence: 0 }).confidence).toBe(0);
  });

  it('defaults confidence to 0.5 only when genuinely absent', () => {
    expect(AIVisionResponseSchema.parse(base).confidence).toBe(0.5);
  });

  it('drops non-whitelisted categories and keeps valid ones', () => {
    const parsed = AIVisionResponseSchema.parse({
      ...base,
      categories: ['layout', 'bogus', 'text', 'explosion'],
    });
    expect(parsed.categories).toEqual(['layout', 'text']);
  });

  it('rejects an out-of-enum severity', () => {
    expect(() => AIVisionResponseSchema.parse({ ...base, severity: 'catastrophic' })).toThrow();
  });

  it('rejects an empty-string severity (the false-clean case)', () => {
    expect(() => AIVisionResponseSchema.parse({ ...base, severity: '' })).toThrow();
  });
});

describe('OllamaVisionClient validates provider responses (issue #66)', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  const config: IrisConfig['ai'] = {
    provider: 'ollama',
    model: 'llava',
    endpoint: 'http://localhost:11434',
    timeout: 1000,
    retryConfig: { maxRetries: 0, initialDelayMs: 1, backoffMultiplier: 2 },
  };

  function mockOllama(body: unknown): void {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: JSON.stringify(body) }),
    }) as unknown as typeof fetch;
  }

  const analyze = () =>
    new OllamaVisionClient(config).analyzeVisualDiff({
      baseline: Buffer.from('a'),
      current: Buffer.from('b'),
    });

  it('rejects an empty severity instead of returning severity:none', async () => {
    // The regression guard: a malformed severity must NOT masquerade as a clean
    // "no difference" result — it must surface as an error.
    mockOllama({ severity: '', confidence: 0.9, reasoning: 'x', categories: [] });
    await expect(analyze()).rejects.toThrow();
  });

  it('rejects an out-of-enum severity', async () => {
    mockOllama({ severity: 'catastrophic', confidence: 0.9, reasoning: 'x', categories: [] });
    await expect(analyze()).rejects.toThrow();
  });

  it('normalizes confidence and categories on a valid response', async () => {
    mockOllama({
      severity: 'moderate',
      confidence: 5,
      reasoning: 'layout shifted',
      categories: ['layout', 'bogus'],
    });
    const result = await analyze();
    expect(result.severity).toBe('moderate');
    expect(result.confidence).toBe(1);
    expect(result.categories).toEqual(['layout']);
  });
});

describe('AIVisionCache rejects corrupt entries (issue #66)', () => {
  let cache: AIVisionCache;
  afterEach(() => cache.close());

  it('treats an invalid cached value as a miss', () => {
    cache = new AIVisionCache({ dbPath: ':memory:' });
    const key = cache.generateKey('h1', 'h2', 'ollama', 'llava');

    // Simulate a corrupt/legacy entry with an invalid severity.
    const corrupt = { severity: 'catastrophic', confidence: 0.9, reasoning: 'x', categories: [] };
    cache.set(key, corrupt as unknown as AIVisionResponse, 'ollama', 'llava');

    expect(cache.get(key)).toBeUndefined();
  });

  it('returns a valid cached value unchanged', () => {
    cache = new AIVisionCache({ dbPath: ':memory:' });
    const key = cache.generateKey('h1', 'h2', 'ollama', 'llava');
    const valid: AIVisionResponse = {
      severity: 'minor',
      confidence: 0.8,
      reasoning: 'ok',
      categories: ['color'],
    };
    cache.set(key, valid, 'ollama', 'llava');

    expect(cache.get(key)).toEqual(valid);
  });
});
