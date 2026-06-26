/**
 * Shared timeout + retry helpers for AI provider calls (issue #29).
 *
 * Cloud SDKs (OpenAI/Anthropic) have their own long built-in timeouts; the
 * Ollama `fetch` calls had none, so a hung server could block indefinitely.
 * These helpers give every provider a bounded, configurable timeout and a
 * single, predictable exponential-backoff retry path for transient failures
 * (429 / 5xx / network) — so a transient blip retries instead of being
 * swallowed as a false "no difference".
 */

/** Retry/backoff settings for {@link withRetry}. */
export interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  backoffMultiplier: number;
}

export const DEFAULT_TIMEOUT_MS = 30000;

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 2,
  initialDelayMs: 500,
  backoffMultiplier: 2,
};

const NETWORK_ERROR_RE =
  /\b(econn\w*|etimedout|enotfound|eai_again|epipe|fetch failed|network|socket hang up|timed? ?out)\b/i;

/**
 * Decide whether an error is worth retrying: rate limits (429), server errors
 * (5xx), aborted/timed-out requests, and low-level network failures. Genuine
 * client errors (4xx other than 429) and parse errors are not retried.
 */
export function isTransientError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const status =
    (error as { status?: number; statusCode?: number }).status ??
    (error as { statusCode?: number }).statusCode;
  if (typeof status === 'number') {
    return status === 429 || status >= 500;
  }

  const name = (error as { name?: string }).name;
  if (name === 'AbortError' || name === 'TimeoutError') return true;

  const code = (error as { code?: string }).code;
  if (typeof code === 'string' && NETWORK_ERROR_RE.test(code)) return true;

  const message = (error as { message?: string }).message;
  if (typeof message === 'string' && NETWORK_ERROR_RE.test(message)) return true;

  return false;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn`, retrying transient failures with exponential backoff. Non-transient
 * errors are rethrown immediately; after `maxRetries` the last error is rethrown
 * so the caller surfaces a failure rather than a false result.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
): Promise<T> {
  let delay = config.initialDelayMs;
  let lastError: unknown;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === config.maxRetries || !isTransientError(error)) {
        throw error;
      }
      await sleep(delay);
      delay *= config.backoffMultiplier;
    }
  }

  // Unreachable: the loop either returns or throws. Satisfies the type checker.
  throw lastError;
}

/**
 * `fetch` with a hard timeout enforced via `AbortController`, so a hung server
 * cannot block the process indefinitely.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
