import {
  LogLevelSchema,
  GitInfoSchema,
  PerformanceMetricSchema,
  ImageMetadataSchema,
  ImageComparisonSchema,
  ErrorContextSchema,
  RetryConfigSchema,
  UtilityError,
  ValidationError,
  RetryableError,
  TimeoutError,
  generateCorrelationId,
  isRetryableError,
  createLogger
} from '../../src/utils/types';

describe('Utility Types', () => {
  describe('Schema Validation', () => {
    it('should validate LogLevelSchema', () => {
      expect(LogLevelSchema.safeParse('debug').success).toBe(true);
      expect(LogLevelSchema.safeParse('info').success).toBe(true);
      expect(LogLevelSchema.safeParse('warn').success).toBe(true);
      expect(LogLevelSchema.safeParse('error').success).toBe(true);
      expect(LogLevelSchema.safeParse('fatal').success).toBe(true);
      expect(LogLevelSchema.safeParse('invalid').success).toBe(false);
    });

    it('should validate GitInfoSchema', () => {
      const validGitInfo = {
        branch: 'main',
        commit: 'abc123',
        author: 'test@example.com',
        timestamp: new Date(),
        message: 'Test commit',
        isDirty: false
      };

      const result = GitInfoSchema.safeParse(validGitInfo);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.branch).toBe('main');
        expect(result.data.isDirty).toBe(false);
      }
    });

    it('should validate PerformanceMetricSchema', () => {
      const validMetric = {
        name: 'first-contentful-paint',
        value: 1250.5,
        unit: 'ms',
        timestamp: new Date(),
        category: 'timing' as const
      };

      const result = PerformanceMetricSchema.safeParse(validMetric);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe('first-contentful-paint');
        expect(result.data.category).toBe('timing');
      }
    });

    it('should validate ImageMetadataSchema', () => {
      const validMetadata = {
        width: 1920,
        height: 1080,
        format: 'png',
        size: 1024000,
        colorSpace: 'srgb',
        hasAlpha: true,
        checksum: 'sha256:abc123...'
      };

      const result = ImageMetadataSchema.safeParse(validMetadata);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.width).toBe(1920);
        expect(result.data.hasAlpha).toBe(true);
      }
    });

    it('should validate ImageComparisonSchema', () => {
      const validComparison = {
        baseline: {
          width: 1920,
          height: 1080,
          format: 'png',
          size: 1024000,
          hasAlpha: false,
          checksum: 'baseline-hash'
        },
        current: {
          width: 1920,
          height: 1080,
          format: 'png',
          size: 1025000,
          hasAlpha: false,
          checksum: 'current-hash'
        },
        similarity: 0.95,
        pixelDifference: 1500,
        dimensions: { width: 1920, height: 1080 },
        regions: [
          { x: 100, y: 200, width: 50, height: 30, difference: 0.1 }
        ]
      };

      const result = ImageComparisonSchema.safeParse(validComparison);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.similarity).toBe(0.95);
        expect(result.data.regions).toHaveLength(1);
      }
    });

    it('should validate RetryConfigSchema', () => {
      const validConfig = {
        maxAttempts: 3,
        delayMs: 1000,
        backoffMultiplier: 2,
        maxDelayMs: 30000,
        retryableErrors: ['ECONNRESET', 'TIMEOUT']
      };

      const result = RetryConfigSchema.safeParse(validConfig);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.maxAttempts).toBe(3);
        expect(result.data.backoffMultiplier).toBe(2);
      }
    });

    it('should apply defaults in RetryConfigSchema', () => {
      const minimalConfig = {
        maxAttempts: 5,
        delayMs: 500
      };

      const result = RetryConfigSchema.safeParse(minimalConfig);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.backoffMultiplier).toBe(2); // default
        expect(result.data.maxDelayMs).toBe(30000); // default
      }
    });
  });

  describe('Error Classes', () => {
    it('should create UtilityError with context', () => {
      const context = {
        code: 'TEST_ERROR',
        message: 'Test error occurred',
        timestamp: new Date(),
        correlationId: 'test-123',
        severity: 'medium' as const,
        category: 'system' as const
      };

      const error = new UtilityError('Test failed', 'TEST_ERROR', context);

      expect(error.name).toBe('UtilityError');
      expect(error.message).toBe('Test failed');
      expect(error.code).toBe('TEST_ERROR');
      expect(error.context).toEqual(context);
    });

    it('should create ValidationError with field details', () => {
      const error = new ValidationError('Invalid field value', 'email', 'invalid-email');

      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.context?.details).toEqual({
        field: 'email',
        value: 'invalid-email'
      });
    });

    it('should create RetryableError', () => {
      const error = new RetryableError('Network failed', true);

      expect(error.code).toBe('RETRYABLE_ERROR');
      expect(error.isRetryable).toBe(true);
    });

    it('should create TimeoutError with operation details', () => {
      const error = new TimeoutError('database-query', 5000);

      expect(error.code).toBe('TIMEOUT_ERROR');
      expect(error.message).toContain('database-query');
      expect(error.message).toContain('5000ms');
      expect(error.context?.details).toEqual({
        operation: 'database-query',
        timeoutMs: 5000
      });
    });
  });

  describe('Utility Functions', () => {
    it('should generate unique correlation IDs', () => {
      const id1 = generateCorrelationId();
      const id2 = generateCorrelationId();

      expect(typeof id1).toBe('string');
      expect(typeof id2).toBe('string');
      expect(id1).not.toBe(id2);
      expect(id1).toMatch(/^\d+-[a-z0-9]{9}$/);
    });

    it('should identify retryable errors correctly', () => {
      // RetryableError
      const retryableError = new RetryableError('Network error', true);
      expect(isRetryableError(retryableError)).toBe(true);

      const nonRetryableError = new RetryableError('Logic error', false);
      expect(isRetryableError(nonRetryableError)).toBe(false);

      // Pattern-based detection
      const timeoutError = new Error('Connection timeout occurred');
      expect(isRetryableError(timeoutError)).toBe(true);

      const networkError = new Error('Network connection failed');
      expect(isRetryableError(networkError)).toBe(true);

      const econnresetError = new Error('ECONNRESET: Connection reset');
      expect(isRetryableError(econnresetError)).toBe(true);

      const logicError = new Error('Invalid argument provided');
      expect(isRetryableError(logicError)).toBe(false);
    });

    it('should create logger with correlation ID', () => {
      const logger = createLogger('test-module');

      // Mock console methods to capture output
      const originalLog = console.info;
      const originalError = console.error;
      let logOutput: string = '';
      let errorOutput: string = '';

      console.info = jest.fn((message: string) => {
        logOutput = message;
      });
      console.error = jest.fn((message: string) => {
        errorOutput = message;
      });

      logger.info('Test message', { key: 'value' });
      logger.error('Error message', new Error('Test error'));

      expect(logOutput).toContain('[INFO]');
      expect(logOutput).toContain('[test-module]');
      expect(logOutput).toContain('Test message');

      expect(errorOutput).toContain('[ERROR]');
      expect(errorOutput).toContain('[test-module]');
      expect(errorOutput).toContain('Error message');

      // Restore original console methods
      console.info = originalLog;
      console.error = originalError;
    });
  });
});