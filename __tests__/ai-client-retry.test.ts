/**
 * Tests for AI client retry/timeout helpers (issue #29).
 *
 * Covers the acceptance criteria:
 * - timeout aborts a hung fetch (AbortController)
 * - a 429-then-success call retries and succeeds
 * - an exhausted retry rethrows (never reported as a clean result)
 * - non-transient errors are not retried
 */

import {
  withRetry,
  fetchWithTimeout,
  isTransientError,
  DEFAULT_RETRY_CONFIG,
  DEFAULT_TIMEOUT_MS,
} from '../src/ai-client/retry';
import { OllamaVisionClient } from '../src/ai-client/vision';
import { IrisConfig } from '../src/config';

// Fast config so backoff delays don't slow the suite.
const FAST = { maxRetries: 3, initialDelayMs: 1, backoffMultiplier: 2 };

describe('isTransientError', () => {
  it('treats 429 and 5xx status as transient', () => {
    expect(isTransientError({ status: 429 })).toBe(true);
    expect(isTransientError({ status: 503 })).toBe(true);
    expect(isTransientError({ status: 500 })).toBe(true);
  });

  it('treats 4xx (other than 429) as non-transient', () => {
    expect(isTransientError({ status: 400 })).toBe(false);
    expect(isTransientError({ status: 404 })).toBe(false);
    expect(isTransientError({ status: 401 })).toBe(false);
  });

  it('treats AbortError (timeout) as transient', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(isTransientError(err)).toBe(true);
  });

  it('treats network errors as transient', () => {
    expect(isTransientError(new Error('fetch failed'))).toBe(true);
    expect(isTransientError(Object.assign(new Error('boom'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isTransientError(new Error('socket hang up'))).toBe(true);
  });

  it('treats a plain unknown error as non-transient', () => {
    expect(isTransientError(new Error('invalid JSON'))).toBe(false);
  });
});

describe('withRetry', () => {
  it('retries a 429 then succeeds', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls === 1) throw { status: 429, message: 'rate limited' };
      return 'ok';
    }, FAST);

    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('gives up after maxRetries and rethrows the last error', async () => {
    let calls = 0;
    const cfg = { ...FAST, maxRetries: 2 };

    await expect(
      withRetry(async () => {
        calls++;
        throw Object.assign(new Error('still 503'), { status: 503 });
      }, cfg),
    ).rejects.toThrow('still 503');

    // initial attempt + 2 retries
    expect(calls).toBe(3);
  });

  it('does not retry a non-transient error', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw Object.assign(new Error('bad request'), { status: 400 });
      }, FAST),
    ).rejects.toThrow('bad request');

    expect(calls).toBe(1);
  });

  it('uses DEFAULT_RETRY_CONFIG when none provided', async () => {
    expect(DEFAULT_RETRY_CONFIG.maxRetries).toBeGreaterThanOrEqual(1);
    const result = await withRetry(async () => 'value');
    expect(result).toBe('value');
  });
});

describe('vision client surfaces transient failures (issue #29)', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('throws after exhausting retries instead of returning severity:none', async () => {
    // Persistent 503 — every attempt is a transient server error.
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 503 }) as unknown as typeof fetch;

    const config: IrisConfig['ai'] = {
      provider: 'ollama',
      model: 'llava',
      endpoint: 'http://localhost:11434',
      timeout: 1000,
      retryConfig: { maxRetries: 2, initialDelayMs: 1, backoffMultiplier: 2 },
    };
    const client = new OllamaVisionClient(config);

    // The key regression guard: a failed analysis must NOT masquerade as a
    // clean "no difference" result — it must surface as an error.
    await expect(
      client.analyzeVisualDiff({ baseline: Buffer.from('a'), current: Buffer.from('b') }),
    ).rejects.toThrow(/Ollama request failed: 503/);

    // initial attempt + 2 retries
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });
});

describe('fetchWithTimeout', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('aborts a hung fetch after the timeout', async () => {
    // Simulate a hung server: resolve only when the abort signal fires.
    global.fetch = jest.fn((_url: string, init?: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }) as unknown as typeof fetch;

    await expect(fetchWithTimeout('http://localhost/hang', {}, 20)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('passes through a successful response and clears the timer', async () => {
    const ok = { ok: true, status: 200 };
    global.fetch = jest.fn().mockResolvedValue(ok) as unknown as typeof fetch;

    const res = await fetchWithTimeout('http://localhost/ok', {}, 1000);
    expect(res).toBe(ok);
  });

  it('exposes a sane default timeout constant', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(30000);
  });
});
