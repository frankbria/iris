import { z } from 'zod';

// Common utility schemas
export const LogLevelSchema = z.enum(['debug', 'info', 'warn', 'error', 'fatal']);
export const TimestampSchema = z.date();
export const FilePathSchema = z.string().min(1);
export const UrlSchema = z.string().url();

// Git integration schemas
export const GitInfoSchema = z.object({
  branch: z.string(),
  commit: z.string(),
  author: z.string(),
  timestamp: z.date(),
  message: z.string(),
  isDirty: z.boolean()
});

export const GitDiffSchema = z.object({
  file: z.string(),
  insertions: z.number(),
  deletions: z.number(),
  changes: z.array(z.object({
    type: z.enum(['add', 'delete', 'modify']),
    line: z.number(),
    content: z.string()
  }))
});

// Performance monitoring schemas
export const PerformanceMetricSchema = z.object({
  name: z.string(),
  value: z.number(),
  unit: z.string(),
  timestamp: z.date(),
  category: z.enum(['timing', 'memory', 'network', 'rendering', 'custom'])
});

export const PerformanceReportSchema = z.object({
  testName: z.string(),
  url: z.string(),
  timestamp: z.date(),
  metrics: z.array(PerformanceMetricSchema),
  navigation: z.object({
    loadEventEnd: z.number(),
    domContentLoadedEventEnd: z.number(),
    firstContentfulPaint: z.number().optional(),
    largestContentfulPaint: z.number().optional(),
    timeToInteractive: z.number().optional()
  }),
  resources: z.array(z.object({
    name: z.string(),
    type: z.string(),
    size: z.number(),
    duration: z.number(),
    transferSize: z.number()
  }))
});

// Image processing schemas
export const ImageMetadataSchema = z.object({
  width: z.number(),
  height: z.number(),
  format: z.string(),
  size: z.number(),
  colorSpace: z.string().optional(),
  hasAlpha: z.boolean(),
  checksum: z.string()
});

export const ImageComparisonSchema = z.object({
  baseline: ImageMetadataSchema,
  current: ImageMetadataSchema,
  similarity: z.number().min(0).max(1),
  pixelDifference: z.number(),
  dimensions: z.object({
    width: z.number(),
    height: z.number()
  }),
  regions: z.array(z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    difference: z.number()
  }))
});

// Error handling schemas
export const ErrorContextSchema = z.object({
  code: z.string(),
  message: z.string(),
  timestamp: z.date(),
  correlationId: z.string(),
  stack: z.string().optional(),
  details: z.record(z.any()).optional(),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  category: z.enum(['validation', 'network', 'filesystem', 'browser', 'system', 'user'])
});

export const RetryConfigSchema = z.object({
  maxAttempts: z.number().min(1).max(10),
  delayMs: z.number().min(0),
  backoffMultiplier: z.number().min(1).default(2),
  maxDelayMs: z.number().min(0).default(30000),
  retryableErrors: z.array(z.string()).optional()
});

// TypeScript types derived from schemas
export type LogLevel = z.infer<typeof LogLevelSchema>;
export type GitInfo = z.infer<typeof GitInfoSchema>;
export type GitDiff = z.infer<typeof GitDiffSchema>;
export type PerformanceMetric = z.infer<typeof PerformanceMetricSchema>;
export type PerformanceReport = z.infer<typeof PerformanceReportSchema>;
export type ImageMetadata = z.infer<typeof ImageMetadataSchema>;
export type ImageComparison = z.infer<typeof ImageComparisonSchema>;
export type ErrorContext = z.infer<typeof ErrorContextSchema>;
export type RetryConfig = z.infer<typeof RetryConfigSchema>;

// Additional utility interfaces
export interface Logger {
  debug(message: string, context?: Record<string, any>): void;
  info(message: string, context?: Record<string, any>): void;
  warn(message: string, context?: Record<string, any>): void;
  error(message: string, error?: Error, context?: Record<string, any>): void;
  fatal(message: string, error?: Error, context?: Record<string, any>): void;
}

export interface Retryable<T> {
  execute(): Promise<T>;
  retry(config: RetryConfig): Promise<T>;
}

export interface Disposable {
  dispose(): Promise<void> | void;
}

export interface AsyncIterableResult<T> {
  items: T[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface CacheOptions {
  ttlMs?: number;
  maxSize?: number;
  keyGenerator?: (args: any[]) => string;
}

export interface RateLimitConfig {
  requestsPerInterval: number;
  intervalMs: number;
  burst?: number;
}

export interface HealthCheck {
  name: string;
  check(): Promise<HealthStatus>;
}

export interface HealthStatus {
  healthy: boolean;
  message?: string;
  details?: Record<string, any>;
  timestamp: Date;
}

// Utility error classes
export class UtilityError extends Error {
  constructor(
    message: string,
    public code: string,
    public context?: ErrorContext
  ) {
    super(message);
    this.name = 'UtilityError';
  }
}

export class ValidationError extends UtilityError {
  constructor(message: string, field?: string, value?: any) {
    super(message, 'VALIDATION_ERROR', {
      code: 'VALIDATION_ERROR',
      message,
      timestamp: new Date(),
      correlationId: generateCorrelationId(),
      severity: 'medium' as const,
      category: 'validation' as const,
      details: { field, value }
    });
  }
}

export class RetryableError extends UtilityError {
  constructor(message: string, public isRetryable: boolean = true) {
    super(message, 'RETRYABLE_ERROR');
  }
}

export class TimeoutError extends UtilityError {
  constructor(operation: string, timeoutMs: number) {
    super(
      `Operation '${operation}' timed out after ${timeoutMs}ms`,
      'TIMEOUT_ERROR',
      {
        code: 'TIMEOUT_ERROR',
        message: `Operation '${operation}' timed out after ${timeoutMs}ms`,
        timestamp: new Date(),
        correlationId: generateCorrelationId(),
        severity: 'high' as const,
        category: 'system' as const,
        details: { operation, timeoutMs }
      }
    );
  }
}

// Utility functions
export function generateCorrelationId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export function isRetryableError(error: Error): boolean {
  if (error instanceof RetryableError) {
    return error.isRetryable;
  }

  // Common retryable error patterns
  const retryablePatterns = [
    /timeout/i,
    /network/i,
    /connection/i,
    /ECONNRESET/,
    /ENOTFOUND/,
    /ETIMEDOUT/
  ];

  return retryablePatterns.some(pattern => pattern.test(error.message));
}

export function createLogger(name: string): Logger {
  const correlationId = generateCorrelationId();

  return {
    debug: (message: string, context?: Record<string, any>) => {
      console.debug(`[${new Date().toISOString()}] [DEBUG] [${name}] [${correlationId}] ${message}`, context);
    },
    info: (message: string, context?: Record<string, any>) => {
      console.info(`[${new Date().toISOString()}] [INFO] [${name}] [${correlationId}] ${message}`, context);
    },
    warn: (message: string, context?: Record<string, any>) => {
      console.warn(`[${new Date().toISOString()}] [WARN] [${name}] [${correlationId}] ${message}`, context);
    },
    error: (message: string, error?: Error, context?: Record<string, any>) => {
      console.error(`[${new Date().toISOString()}] [ERROR] [${name}] [${correlationId}] ${message}`, error, context);
    },
    fatal: (message: string, error?: Error, context?: Record<string, any>) => {
      console.error(`[${new Date().toISOString()}] [FATAL] [${name}] [${correlationId}] ${message}`, error, context);
    }
  };
}