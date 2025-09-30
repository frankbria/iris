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
  HealthStatus
} from './types';

// Error classes
export {
  UtilityError,
  ValidationError,
  RetryableError,
  TimeoutError
} from './types';

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
  RetryConfigSchema
} from './types';

// Utility functions
export {
  generateCorrelationId,
  isRetryableError,
  createLogger
} from './types';

// Import types for function signatures
import type {
  GitInfo,
  ImageComparison,
  PerformanceMetric,
  RetryConfig
} from './types';
import { isRetryableError } from './types';

// Migration utilities
export {
  Migration,
  MigrationRunner,
  applyPhase2Migration,
  Phase2Migration
} from './migration';

// TODO: Implement additional utility modules
// This is a Phase 2 module that will be implemented in stages:
// 1. ImageProcessor - Sharp-based image processing utilities
// 2. GitIntegration - Git operations for baseline management
// 3. PerformanceMonitor - Performance tracking and optimization
// 4. ErrorHandling - Enhanced error handling and recovery
// 5. Logger - Structured logging with correlation IDs

/**
 * Process image with Sharp for visual testing.
 *
 * @param imagePath Path to image file
 * @param options Processing options
 */
export async function processImage(
  imagePath: string,
  options?: {
    resize?: { width: number; height: number };
    format?: 'png' | 'jpeg' | 'webp';
    quality?: number;
  }
): Promise<Buffer> {
  // TODO: Implement image processing with Sharp
  throw new Error('Image processing not yet implemented - Phase 2 in progress');
}

/**
 * Get Git information for current repository.
 *
 * @param repoPath Path to Git repository
 */
export async function getGitInfo(repoPath: string): Promise<GitInfo> {
  // TODO: Implement Git integration
  throw new Error('Git integration not yet implemented - Phase 2 in progress');
}

/**
 * Compare two images and return similarity metrics.
 *
 * @param baselinePath Path to baseline image
 * @param candidatePath Path to candidate image
 * @param options Comparison options
 */
export async function compareImages(
  baselinePath: string,
  candidatePath: string,
  options?: {
    threshold?: number;
    includeRegions?: boolean;
  }
): Promise<ImageComparison> {
  // TODO: Implement image comparison
  throw new Error('Image comparison not yet implemented - Phase 2 in progress');
}

/**
 * Monitor performance metrics for a function execution.
 *
 * @param fn Function to monitor
 * @param name Metric name
 */
export async function withPerformanceMonitoring<T>(
  fn: () => Promise<T>,
  name: string
): Promise<{ result: T; metrics: PerformanceMetric[] }> {
  // TODO: Implement performance monitoring
  throw new Error('Performance monitoring not yet implemented - Phase 2 in progress');
}

/**
 * Retry a function with exponential backoff.
 *
 * @param fn Function to retry
 * @param config Retry configuration
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig
): Promise<T> {
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
        await new Promise(resolve => setTimeout(resolve, delay));
        delay = Math.min(delay * config.backoffMultiplier, config.maxDelayMs);
      }
    }
  }

  throw lastError!;
}