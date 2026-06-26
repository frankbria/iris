/**
 * IRIS Shared Utilities Module
 *
 * Provides shared utility functions for Phase 2 modules including:
 * - Image processing with Sharp
 * - Git integration for baseline management
 * - Performance monitoring and optimization
 * - Enhanced error handling and logging
 * - Retry mechanisms and resilience patterns
 */

// Core types and interfaces
export type {
  LogLevel,
  GitInfo,
  GitDiff,
  PerformanceMetric,
  PerformanceReport,
  ImageMetadata,
  ImageComparison,
  ErrorContext,
  RetryConfig,
  Logger,
  Retryable,
  Disposable,
  AsyncIterableResult,
  CacheOptions,
  RateLimitConfig,
  HealthCheck,
  HealthStatus,
} from './types';

// Error classes
export { UtilityError, ValidationError, RetryableError, TimeoutError } from './types';

// Zod schemas
export {
  LogLevelSchema,
  TimestampSchema,
  FilePathSchema,
  UrlSchema,
  GitInfoSchema,
  GitDiffSchema,
  PerformanceMetricSchema,
  PerformanceReportSchema,
  ImageMetadataSchema,
  ImageComparisonSchema,
  ErrorContextSchema,
  RetryConfigSchema,
} from './types';

// Utility functions
export { generateCorrelationId, isRetryableError, createLogger } from './types';

// Import types for function signatures
import type { RetryConfig } from './types';
import { isRetryableError } from './types';

/**
 * Retry a function with exponential backoff.
 *
 * @param fn Function to retry
 * @param config Retry configuration
 */
export async function withRetry<T>(fn: () => Promise<T>, config: RetryConfig): Promise<T> {
  let lastError: Error;
  let delay = config.delayMs;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      // Check if error is retryable
      if (!isRetryableError(lastError)) {
        throw lastError;
      }

      // Don't retry on last attempt
      if (attempt === config.maxAttempts) {
        break;
      }

      // Wait before retry
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * config.backoffMultiplier, config.maxDelayMs);
      }
    }
  }

  throw lastError!;
}
