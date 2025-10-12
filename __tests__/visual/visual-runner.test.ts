/**
 * Visual Test Runner Tests
 *
 * Comprehensive test suite for VisualTestRunner orchestration module
 */

import { Browser, Page, BrowserContext } from 'playwright';
import { VisualTestRunner } from '../../src/visual/visual-runner';
import { VisualCaptureEngine } from '../../src/visual/capture';
import { VisualDiffEngine } from '../../src/visual/diff';
import { BaselineManager } from '../../src/visual/baseline';
import { StorageManager } from '../../src/visual/storage';
import { AIVisualClassifier } from '../../src/visual/ai-classifier';

// Mock Playwright
jest.mock('playwright');

// Mock visual module components
jest.mock('../../src/visual/capture');
jest.mock('../../src/visual/diff');
jest.mock('../../src/visual/baseline');
jest.mock('../../src/visual/storage');
jest.mock('../../src/visual/ai-classifier');

describe('VisualTestRunner', () => {
  let mockBrowser: jest.Mocked<Browser>;
  let mockContext: jest.Mocked<BrowserContext>;
  let mockPage: jest.Mocked<Page>;
  let mockCaptureEngine: jest.Mocked<VisualCaptureEngine>;
  let mockDiffEngine: jest.Mocked<VisualDiffEngine>;
  let mockBaselineManager: jest.Mocked<BaselineManager>;
  let mockStorageManager: jest.Mocked<StorageManager>;
  let mockAIClassifier: jest.Mocked<AIVisualClassifier>;
  let visualRunner: VisualTestRunner;

  const defaultConfig = {
    pages: ['/', '/about'],
    baseline: {
      strategy: 'branch' as const,
      reference: 'main'
    },
    capture: {
      viewport: { width: 1920, height: 1080 },
      fullPage: true,
      mask: [],
      format: 'png' as const,
      quality: 90,
      stabilization: {
        waitForFonts: true,
        disableAnimations: true,
        delay: 100,
        waitForNetworkIdle: true,
        networkIdleTimeout: 3000
      }
    },
    diff: {
      threshold: 0.95,
      semanticAnalysis: false,
      aiProvider: 'openai' as const,
      antiAliasing: true,
      regions: [],
      maxConcurrency: 3
    }
  };

  beforeEach(() => {
    // Mock Playwright Page
    mockPage = {
      goto: jest.fn().mockResolvedValue(undefined),
      evaluate: jest.fn().mockResolvedValue(undefined),
      addStyleTag: jest.fn().mockResolvedValue(undefined),
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
      waitForLoadState: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined)
    } as any;

    // Mock Playwright BrowserContext
    mockContext = {
      newPage: jest.fn().mockResolvedValue(mockPage),
      close: jest.fn().mockResolvedValue(undefined)
    } as any;

    // Mock Playwright Browser
    mockBrowser = {
      newContext: jest.fn().mockResolvedValue(mockContext),
      close: jest.fn().mockResolvedValue(undefined)
    } as any;

    // Mock chromium.launch
    const { chromium } = require('playwright');
    chromium.launch = jest.fn().mockResolvedValue(mockBrowser);

    // Mock VisualCaptureEngine
    mockCaptureEngine = {
      capture: jest.fn().mockResolvedValue({
        success: true,
        buffer: Buffer.from('test-screenshot'),
        metadata: {
          url: 'http://localhost:3000/',
          title: 'Test Page',
          fullPage: true,
          viewport: { width: 1920, height: 1080 },
          hash: 'test-hash',
          timestamp: Date.now()
        }
      })
    } as any;

    (VisualCaptureEngine as jest.MockedClass<typeof VisualCaptureEngine>).mockImplementation(() => mockCaptureEngine);

    // Mock VisualDiffEngine
    mockDiffEngine = {
      compare: jest.fn().mockResolvedValue({
        success: true,
        passed: true,
        similarity: 1.0,
        pixelDifference: 0,
        threshold: 0.95,
        diffBuffer: Buffer.from('test-diff')
      })
    } as any;

    (VisualDiffEngine as jest.MockedClass<typeof VisualDiffEngine>).mockImplementation(() => mockDiffEngine);

    // Mock BaselineManager
    mockBaselineManager = {
      loadBaseline: jest.fn().mockResolvedValue({
        success: true,
        buffer: Buffer.from('test-baseline'),
        metadata: {}
      }),
      saveBaseline: jest.fn().mockResolvedValue(undefined)
    } as any;

    (BaselineManager as jest.MockedClass<typeof BaselineManager>).mockImplementation(() => mockBaselineManager);

    // Mock StorageManager
    mockStorageManager = {
      ensureTestDirectory: jest.fn().mockResolvedValue('/test/dir')
    } as any;

    (StorageManager as jest.MockedClass<typeof StorageManager>).mockImplementation(() => mockStorageManager);

    // Mock fs.writeFileSync
    const fs = require('fs');
    jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

    visualRunner = new VisualTestRunner(defaultConfig);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('run', () => {
    it('should run visual regression tests for all configured pages', async () => {
      const result = await visualRunner.run();

      expect(result).toBeDefined();
      expect(result.summary.totalComparisons).toBe(2);
      expect(result.results).toHaveLength(2);
      expect(mockPage.goto).toHaveBeenCalledTimes(2);
      expect(mockCaptureEngine.capture).toHaveBeenCalledTimes(2);
    });

    it('should launch and close browser', async () => {
      const { chromium } = require('playwright');

      await visualRunner.run();

      expect(chromium.launch).toHaveBeenCalledWith({ headless: true });
      expect(mockBrowser.close).toHaveBeenCalled();
    });

    it('should close browser even if tests fail', async () => {
      mockCaptureEngine.capture.mockRejectedValueOnce(new Error('Capture failed'));

      await visualRunner.run();

      expect(mockBrowser.close).toHaveBeenCalled();
    });

    it('should navigate to correct URLs for pages', async () => {
      await visualRunner.run();

      expect(mockPage.goto).toHaveBeenCalledWith('http://localhost:3000/', { waitUntil: 'networkidle' });
      expect(mockPage.goto).toHaveBeenCalledWith('http://localhost:3000/about', { waitUntil: 'networkidle' });
    });

    it('should handle absolute URLs', async () => {
      const customConfig = {
        ...defaultConfig,
        pages: ['https://example.com/page1', 'https://example.com/page2']
      };
      visualRunner = new VisualTestRunner(customConfig);

      await visualRunner.run();

      expect(mockPage.goto).toHaveBeenCalledWith('https://example.com/page1', { waitUntil: 'networkidle' });
      expect(mockPage.goto).toHaveBeenCalledWith('https://example.com/page2', { waitUntil: 'networkidle' });
    });

    it('should create new baseline when updateBaseline is true', async () => {
      const configWithUpdate = {
        ...defaultConfig,
        updateBaseline: true
      };
      visualRunner = new VisualTestRunner(configWithUpdate);

      const result = await visualRunner.run();

      expect(mockBaselineManager.saveBaseline).toHaveBeenCalledTimes(2);
      expect(result.summary.newBaselines).toBe(2);
      expect(result.summary.passed).toBe(2);
    });

    it('should create new baseline when baseline does not exist', async () => {
      mockBaselineManager.loadBaseline.mockResolvedValue({
        success: false,
        error: 'Baseline not found'
      });

      const result = await visualRunner.run();

      expect(mockBaselineManager.saveBaseline).toHaveBeenCalledTimes(2);
      expect(result.summary.newBaselines).toBe(2);
    });

    it('should compare with baseline when it exists', async () => {
      const result = await visualRunner.run();

      expect(mockDiffEngine.compare).toHaveBeenCalledTimes(2);
      expect(result.summary.totalComparisons).toBe(2);
      expect(result.summary.passed).toBe(2);
    });

    it('should mark test as failed when similarity below threshold', async () => {
      mockDiffEngine.compare.mockResolvedValue({
        success: true,
        passed: false,
        similarity: 0.80,
        pixelDifference: 0.20,
        threshold: 0.95,
        diffBuffer: Buffer.from('test-diff')
      });

      const result = await visualRunner.run();

      expect(result.summary.passed).toBe(0);
      expect(result.summary.failed).toBe(2);
    });

    it('should calculate overall status correctly', async () => {
      mockDiffEngine.compare
        .mockResolvedValueOnce({
          success: true,
          passed: true,
          similarity: 0.96,
          pixelDifference: 0.04,
          threshold: 0.95
        })
        .mockResolvedValueOnce({
          success: true,
          passed: false,
          similarity: 0.80,
          pixelDifference: 0.20,
          threshold: 0.95,
          diffBuffer: Buffer.from('test-diff')
        });

      const result = await visualRunner.run();

      expect(result.summary.passed).toBe(1);
      expect(result.summary.failed).toBe(1);
      expect(result.summary.overallStatus).toBe('failed');
    });

    it('should include duration in results', async () => {
      const result = await visualRunner.run();

      expect(result.duration).toBeGreaterThanOrEqual(0);
      expect(typeof result.duration).toBe('number');
    });
  });

  describe('stabilization', () => {
    it('should wait for fonts when configured', async () => {
      await visualRunner.run();

      expect(mockPage.evaluate).toHaveBeenCalledWith(expect.any(Function));
    });

    it('should disable animations when configured', async () => {
      await visualRunner.run();

      expect(mockPage.addStyleTag).toHaveBeenCalledWith({
        content: expect.stringContaining('animation-duration: 0s')
      });
    });

    it('should apply stabilization delay when configured', async () => {
      await visualRunner.run();

      expect(mockPage.waitForTimeout).toHaveBeenCalledWith(100);
    });

    it('should wait for network idle when configured', async () => {
      await visualRunner.run();

      expect(mockPage.waitForLoadState).toHaveBeenCalledWith('networkidle', {
        timeout: 3000
      });
    });

    it('should skip stabilization steps when disabled', async () => {
      const configNoStabilization = {
        ...defaultConfig,
        capture: {
          ...defaultConfig.capture,
          stabilization: {
            waitForFonts: false,
            disableAnimations: false,
            delay: 0,
            waitForNetworkIdle: false,
            networkIdleTimeout: 0
          }
        }
      };
      visualRunner = new VisualTestRunner(configNoStabilization);

      await visualRunner.run();

      // Should not call these stabilization methods
      expect(mockPage.evaluate).not.toHaveBeenCalled();
      expect(mockPage.addStyleTag).not.toHaveBeenCalled();
      expect(mockPage.waitForTimeout).not.toHaveBeenCalled();
      expect(mockPage.waitForLoadState).not.toHaveBeenCalled();
    });
  });

  describe('multi-device testing', () => {
    it('should test multiple devices', async () => {
      // Create runner BEFORE jest.clearAllMocks() to preserve mocks
      const configWithDevices = {
        ...defaultConfig,
        pages: ['/', '/about'],
        devices: ['desktop', 'mobile', 'tablet']
      };

      // Clear just the call history, not the implementations
      mockBrowser.newContext.mockClear();
      mockCaptureEngine.capture.mockClear();

      const multiDeviceRunner = new VisualTestRunner(configWithDevices);
      await multiDeviceRunner.run();

      // Should create 6 contexts (2 pages × 3 devices)
      expect(mockBrowser.newContext).toHaveBeenCalledTimes(6);
      expect(mockCaptureEngine.capture).toHaveBeenCalledTimes(6);
    });

    it('should use device-specific viewports', async () => {
      const configWithMobile = {
        ...defaultConfig,
        devices: ['mobile']
      };
      visualRunner = new VisualTestRunner(configWithMobile);

      await visualRunner.run();

      expect(mockBrowser.newContext).toHaveBeenCalledWith({
        viewport: { width: 375, height: 667 }
      });
    });

    it('should default to desktop viewport when no devices specified', async () => {
      await visualRunner.run();

      expect(mockBrowser.newContext).toHaveBeenCalledWith({
        viewport: { width: 1920, height: 1080 }
      });
    });
  });

  describe('AI semantic analysis', () => {
    beforeEach(() => {
      // Mock AIVisualClassifier
      mockAIClassifier = {
        analyzeChange: jest.fn().mockResolvedValue({
          classification: 'layout',
          confidence: 0.85,
          description: 'Significant layout shift detected',
          severity: 'medium',
          suggestions: ['Review layout changes', 'Check responsive behavior'],
          isIntentional: false,
          changeType: 'layout' as const,
          reasoning: 'Detected significant layout shift in header area'
        })
      } as any;

      (AIVisualClassifier as jest.MockedClass<typeof AIVisualClassifier>).mockImplementation(() => mockAIClassifier);
    });

    it('should run AI analysis when enabled and test fails', async () => {
      const configWithAI = {
        ...defaultConfig,
        diff: {
          ...defaultConfig.diff,
          semanticAnalysis: true
        }
      };
      visualRunner = new VisualTestRunner(configWithAI);

      mockDiffEngine.compare.mockResolvedValue({
        success: true,
        passed: false,
        similarity: 0.80,
        pixelDifference: 0.20,
        threshold: 0.95,
        diffBuffer: Buffer.from('test-diff')
      });

      const result = await visualRunner.run();

      expect(mockAIClassifier.analyzeChange).toHaveBeenCalledTimes(2);
      expect(result.results[0].aiAnalysis).toBeDefined();
      expect(result.results[0].aiAnalysis?.classification).toBe('layout');
      expect(result.results[0].aiAnalysis?.confidence).toBe(0.85);
    });

    it('should not run AI analysis when test passes', async () => {
      const configWithAI = {
        ...defaultConfig,
        diff: {
          ...defaultConfig.diff,
          semanticAnalysis: true
        }
      };
      visualRunner = new VisualTestRunner(configWithAI);

      mockDiffEngine.compare.mockResolvedValue({
        success: true,
        passed: true,
        similarity: 0.96,
        pixelDifference: 0.04,
        threshold: 0.95
      });

      const result = await visualRunner.run();

      expect(mockAIClassifier.analyzeChange).not.toHaveBeenCalled();
      expect(result.results[0].aiAnalysis).toBeUndefined();
    });

    it('should map AI severity to test severity', async () => {
      const configWithAI = {
        ...defaultConfig,
        diff: {
          ...defaultConfig.diff,
          semanticAnalysis: true
        }
      };
      visualRunner = new VisualTestRunner(configWithAI);

      mockDiffEngine.compare.mockResolvedValue({
        success: true,
        passed: false,
        similarity: 0.80,
        pixelDifference: 0.20,
        threshold: 0.95,
        diffBuffer: Buffer.from('test-diff')
      });

      mockAIClassifier.analyzeChange.mockResolvedValue({
        classification: 'layout',
        confidence: 0.95,
        description: 'Critical layout issue',
        severity: 'critical',
        suggestions: ['Immediate review required', 'Rollback changes'],
        isIntentional: false,
        changeType: 'layout' as const,
        reasoning: 'Critical structural changes detected'
      });

      const result = await visualRunner.run();

      expect(result.results[0].severity).toBe('breaking');
      expect(result.summary.severityCounts.breaking).toBe(2);
    });
  });

  describe('severity estimation without AI', () => {
    it('should estimate severity as breaking for low similarity', async () => {
      mockDiffEngine.compare.mockResolvedValue({
        success: true,
        passed: false,
        similarity: 0.80,
        pixelDifference: 0.20,
        threshold: 0.95,
        diffBuffer: Buffer.from('test-diff')
      });

      const result = await visualRunner.run();

      expect(result.results[0].severity).toBe('breaking');
    });

    it('should estimate severity as moderate for medium similarity', async () => {
      mockDiffEngine.compare.mockResolvedValue({
        success: true,
        passed: false,
        similarity: 0.90,
        pixelDifference: 0.10,
        threshold: 0.95,
        diffBuffer: Buffer.from('test-diff')
      });

      const result = await visualRunner.run();

      expect(result.results[0].severity).toBe('moderate');
    });

    it('should estimate severity as minor for high similarity', async () => {
      mockDiffEngine.compare.mockResolvedValue({
        success: true,
        passed: false,
        similarity: 0.96,
        pixelDifference: 0.04,
        threshold: 0.95,
        diffBuffer: Buffer.from('test-diff')
      });

      const result = await visualRunner.run();

      // similarity >= 0.95 AND pixelDifference <= 0.05 = minor
      expect(result.results[0].severity).toBe('minor');
    });
  });

  describe('parallel execution', () => {
    it('should respect maxConcurrency setting', async () => {
      // Test that all pages are tested regardless of concurrency limit
      const configWithConcurrency = {
        ...defaultConfig,
        pages: ['/', '/about', '/contact', '/services'],
        diff: {
          ...defaultConfig.diff,
          maxConcurrency: 2
        }
      };

      // Clear just the call history, not the implementations
      mockBrowser.newContext.mockClear();
      mockCaptureEngine.capture.mockClear();

      const concurrencyRunner = new VisualTestRunner(configWithConcurrency);
      await concurrencyRunner.run();

      // Should create 4 contexts (1 per page), despite concurrency limit of 2
      expect(mockBrowser.newContext).toHaveBeenCalledTimes(4);
      expect(mockCaptureEngine.capture).toHaveBeenCalledTimes(4);
    });

    it('should handle test failures gracefully in parallel execution', async () => {
      mockCaptureEngine.capture
        .mockResolvedValueOnce({
          success: true,
          buffer: Buffer.from('test'),
          metadata: {
            url: 'http://localhost:3000/',
            title: 'Test',
            fullPage: true,
            viewport: { width: 1920, height: 1080 },
            hash: 'test-hash',
            timestamp: Date.now()
          }
        })
        .mockRejectedValueOnce(new Error('Capture failed'));

      const result = await visualRunner.run();

      expect(result.summary.totalComparisons).toBe(2);
      expect(result.summary.failed).toBeGreaterThan(0);
    });
  });

  describe('diff image generation', () => {
    it('should save diff images when tests fail', async () => {
      const fs = require('fs');
      const writeFileSyncSpy = jest.spyOn(fs, 'writeFileSync');

      mockDiffEngine.compare.mockResolvedValue({
        success: true,
        passed: false,
        similarity: 0.80,
        pixelDifference: 0.20,
        threshold: 0.95,
        diffBuffer: Buffer.from('test-diff')
      });

      const result = await visualRunner.run();

      // Should write: current screenshot, baseline, and diff
      expect(writeFileSyncSpy).toHaveBeenCalledTimes(6); // 2 pages × 3 files each
      expect(result.results[0].diffPath).toBeDefined();
    });

    it('should not save diff images when tests pass', async () => {
      const fs = require('fs');
      const writeFileSyncSpy = jest.spyOn(fs, 'writeFileSync');
      writeFileSyncSpy.mockClear();

      mockDiffEngine.compare.mockResolvedValue({
        success: true,
        passed: true,
        similarity: 0.96,
        pixelDifference: 0.04,
        threshold: 0.95
      });

      const result = await visualRunner.run();

      // Should write: current screenshot and baseline, but no diff
      expect(writeFileSyncSpy).toHaveBeenCalledTimes(4); // 2 pages × 2 files each
      expect(result.results[0].diffPath).toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('should handle capture errors gracefully', async () => {
      mockCaptureEngine.capture.mockRejectedValue(new Error('Screenshot failed'));

      const result = await visualRunner.run();

      expect(result.summary.failed).toBe(2);
      expect(result.results[0].passed).toBe(false);
    });

    it('should handle baseline loading errors', async () => {
      mockBaselineManager.loadBaseline.mockResolvedValue({
        success: false,
        error: 'Baseline load failed'
      });

      const result = await visualRunner.run();

      // Should treat as new baseline when loadBaseline returns success:false
      expect(mockBaselineManager.saveBaseline).toHaveBeenCalled();
      expect(result.summary.newBaselines).toBe(2);
    });

    it('should handle diff comparison errors', async () => {
      mockDiffEngine.compare.mockResolvedValue({
        success: false,
        passed: false,
        similarity: 0,
        pixelDifference: 0,
        threshold: 0.95,
        error: 'Comparison failed'
      });

      const result = await visualRunner.run();

      expect(result.summary.failed).toBe(2);
    });
  });
});
