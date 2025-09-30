import {
  VisualTestConfigSchema,
  VisualDiffResultSchema,
  VisualReportSchema,
  VisualTestError,
  BaselineNotFoundError,
  ScreenshotCaptureError,
  DiffAnalysisError
} from '../../src/visual/types';

describe('Visual Testing Types', () => {
  describe('VisualTestConfigSchema', () => {
    it('should validate valid test configuration', () => {
      const validConfig = {
        testName: 'homepage-test',
        url: 'https://example.com',
        viewport: { width: 1920, height: 1080 },
        threshold: 0.1,
        waitForTimeout: 5000,
        disableAnimations: true,
        fullPage: false
      };

      const result = VisualTestConfigSchema.safeParse(validConfig);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.testName).toBe('homepage-test');
        expect(result.data.threshold).toBe(0.1);
      }
    });

    it('should reject invalid test configuration', () => {
      const invalidConfig = {
        testName: '', // Empty string should fail
        url: 'not-a-url', // Invalid URL
        threshold: 1.5 // Threshold > 1 should fail
      };

      const result = VisualTestConfigSchema.safeParse(invalidConfig);
      expect(result.success).toBe(false);
    });

    it('should apply default values', () => {
      const minimalConfig = {
        testName: 'test',
        url: 'https://example.com'
      };

      const result = VisualTestConfigSchema.safeParse(minimalConfig);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.threshold).toBe(0.1);
        expect(result.data.waitForTimeout).toBe(5000);
        expect(result.data.disableAnimations).toBe(true);
        expect(result.data.fullPage).toBe(false);
      }
    });

    it('should validate ignore regions', () => {
      const configWithRegions = {
        testName: 'test-with-regions',
        url: 'https://example.com',
        ignoreRegions: [
          { x: 0, y: 0, width: 100, height: 50 },
          { x: 200, y: 100, width: 150, height: 75 }
        ]
      };

      const result = VisualTestConfigSchema.safeParse(configWithRegions);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.ignoreRegions).toHaveLength(2);
        expect(result.data.ignoreRegions![0].x).toBe(0);
      }
    });
  });

  describe('VisualDiffResultSchema', () => {
    it('should validate valid diff result', () => {
      const validResult = {
        testName: 'homepage-test',
        passed: true,
        similarity: 0.95,
        pixelDifference: 150,
        threshold: 0.1,
        baselineExists: true,
        screenshotPath: '/path/to/screenshot.png',
        baselinePath: '/path/to/baseline.png',
        diffPath: '/path/to/diff.png',
        timestamp: new Date(),
        viewport: { width: 1920, height: 1080 },
        metadata: { browser: 'chromium' }
      };

      const result = VisualDiffResultSchema.safeParse(validResult);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.testName).toBe('homepage-test');
        expect(result.data.passed).toBe(true);
        expect(result.data.similarity).toBe(0.95);
      }
    });

    it('should reject invalid similarity values', () => {
      const invalidResult = {
        testName: 'test',
        passed: true,
        similarity: 1.5, // > 1.0 should fail
        pixelDifference: 150,
        threshold: 0.1,
        baselineExists: true,
        screenshotPath: '/path/to/screenshot.png',
        timestamp: new Date(),
        viewport: { width: 1920, height: 1080 }
      };

      const result = VisualDiffResultSchema.safeParse(invalidResult);
      expect(result.success).toBe(false);
    });
  });

  describe('VisualReportSchema', () => {
    it('should validate complete visual report', () => {
      const validReport = {
        testSuite: 'e2e-visual-tests',
        timestamp: new Date(),
        summary: {
          total: 10,
          passed: 8,
          failed: 2,
          newBaselines: 1
        },
        results: [],
        environment: {
          browser: 'chromium',
          viewport: { width: 1920, height: 1080 },
          platform: 'linux',
          gitBranch: 'main',
          gitCommit: 'abc123'
        }
      };

      const result = VisualReportSchema.safeParse(validReport);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.testSuite).toBe('e2e-visual-tests');
        expect(result.data.summary.total).toBe(10);
      }
    });
  });

  describe('Error Classes', () => {
    it('should create VisualTestError with correct properties', () => {
      const error = new VisualTestError('Test failed', 'TEST_FAILED', { detail: 'value' });

      expect(error.name).toBe('VisualTestError');
      expect(error.message).toBe('Test failed');
      expect(error.code).toBe('TEST_FAILED');
      expect(error.details).toEqual({ detail: 'value' });
      expect(error instanceof Error).toBe(true);
    });

    it('should create BaselineNotFoundError with correct message', () => {
      const error = new BaselineNotFoundError('test-name', '/path/to/baseline.png');

      expect(error.name).toBe('VisualTestError');
      expect(error.code).toBe('BASELINE_NOT_FOUND');
      expect(error.message).toContain('test-name');
      expect(error.message).toContain('/path/to/baseline.png');
      expect(error.details).toEqual({
        testName: 'test-name',
        baselinePath: '/path/to/baseline.png'
      });
    });

    it('should create ScreenshotCaptureError', () => {
      const error = new ScreenshotCaptureError('Screenshot failed', { selector: '.test' });

      expect(error.code).toBe('SCREENSHOT_CAPTURE_ERROR');
      expect(error.details).toEqual({ selector: '.test' });
    });

    it('should create DiffAnalysisError', () => {
      const error = new DiffAnalysisError('Analysis failed');

      expect(error.code).toBe('DIFF_ANALYSIS_ERROR');
    });
  });
});