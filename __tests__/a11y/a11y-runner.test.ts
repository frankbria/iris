/**
 * Accessibility Runner Tests
 *
 * Comprehensive test suite for AccessibilityRunner orchestration module
 */

import { Browser, Page, BrowserContext } from 'playwright';
import { AccessibilityRunner } from '../../src/a11y/a11y-runner';
import { AxeRunner } from '../../src/a11y/axe-integration';
import { KeyboardTester } from '../../src/a11y/keyboard-tester';

// Mock Playwright
jest.mock('playwright');

// Mock child modules
jest.mock('../../src/a11y/axe-integration');
jest.mock('../../src/a11y/keyboard-tester');

describe('AccessibilityRunner', () => {
  let mockBrowser: jest.Mocked<Browser>;
  let mockContext: jest.Mocked<BrowserContext>;
  let mockPage: jest.Mocked<Page>;
  let mockAxeRunner: jest.Mocked<AxeRunner>;
  let mockKeyboardTester: jest.Mocked<KeyboardTester>;
  let accessibilityRunner: AccessibilityRunner;

  const defaultConfig = {
    pages: ['/', '/about'],
    axe: {
      rules: {},
      tags: ['wcag2a', 'wcag2aa'],
      include: [],
      exclude: [],
      disableRules: [],
      timeout: 10000
    },
    keyboard: {
      testFocusOrder: true,
      testTrapDetection: true,
      testArrowKeyNavigation: true,
      testEscapeHandling: true,
      customSequences: []
    },
    screenReader: {
      testAriaLabels: true,
      testLandmarkNavigation: true,
      testImageAltText: true,
      testHeadingStructure: true,
      simulateScreenReader: true
    },
    failureThreshold: {
      critical: true,
      serious: true,
      moderate: false,
      minor: false
    },
    reporting: {
      includePassedTests: true,
      groupByImpact: true,
      includeScreenshots: false
    }
  };

  beforeEach(() => {
    // Mock Playwright Page
    mockPage = {
      goto: jest.fn().mockResolvedValue(undefined),
      evaluate: jest.fn().mockResolvedValue([]),
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

    // Mock AxeRunner
    mockAxeRunner = {
      run: jest.fn().mockResolvedValue({
        testName: 'test',
        url: 'https://example.com',
        timestamp: new Date(),
        passed: true,
        violations: [],
        passes: [],
        incomplete: [],
        inapplicable: [],
        summary: {
          total: 0,
          violations: 0,
          passes: 0,
          incomplete: 0,
          inapplicable: 0
        },
        testRunner: {
          name: 'axe-core',
          version: '4.8.0'
        }
      }),
      getSeverityCounts: jest.fn().mockReturnValue({
        critical: 0,
        serious: 0,
        moderate: 0,
        minor: 0
      }),
      checkThreshold: jest.fn().mockReturnValue(true)
    } as any;

    (AxeRunner as jest.MockedClass<typeof AxeRunner>).mockImplementation(() => mockAxeRunner);

    // Mock KeyboardTester
    mockKeyboardTester = {
      run: jest.fn().mockResolvedValue({
        testName: 'keyboard-test',
        passed: true,
        interactions: [],
        focusOrder: [],
        trapTests: []
      })
    } as any;

    (KeyboardTester as jest.MockedClass<typeof KeyboardTester>).mockImplementation(() => mockKeyboardTester);

    accessibilityRunner = new AccessibilityRunner(defaultConfig);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('run', () => {
    it('should run accessibility tests for all configured pages', async () => {
      const result = await accessibilityRunner.run();

      expect(result).toBeDefined();
      expect(result.summary.pagesTested).toBe(2);
      expect(result.results).toHaveLength(2);
      expect(mockPage.goto).toHaveBeenCalledTimes(2);
      expect(mockAxeRunner.run).toHaveBeenCalledTimes(2);
    });

    it('should launch and close browser', async () => {
      const { chromium } = require('playwright');

      await accessibilityRunner.run();

      expect(chromium.launch).toHaveBeenCalledWith({ headless: true });
      expect(mockBrowser.close).toHaveBeenCalled();
    });

    it('should close browser even if tests fail', async () => {
      mockAxeRunner.run.mockRejectedValueOnce(new Error('Test failed'));

      await expect(accessibilityRunner.run()).rejects.toThrow();

      expect(mockBrowser.close).toHaveBeenCalled();
    });

    it('should calculate accessibility score based on violations', async () => {
      mockAxeRunner.run.mockResolvedValueOnce({
        testName: 'test',
        url: 'https://example.com',
        timestamp: new Date(),
        passed: false,
        violations: [
          {
            id: 'critical-issue',
            impact: 'critical',
            tags: [],
            description: '',
            help: '',
            helpUrl: '',
            nodes: []
          }
        ],
        passes: [],
        incomplete: [],
        inapplicable: [],
        summary: {
          total: 1,
          violations: 1,
          passes: 0,
          incomplete: 0,
          inapplicable: 0
        },
        testRunner: {
          name: 'axe-core',
          version: '4.8.0'
        }
      });

      mockAxeRunner.getSeverityCounts.mockReturnValueOnce({
        critical: 1,
        serious: 0,
        moderate: 0,
        minor: 0
      });

      const result = await accessibilityRunner.run();

      expect(result.summary.violationsBySeverity.critical).toBe(1);
      expect(result.summary.score).toBeLessThan(100); // Score reduced by violations
    });

    it('should aggregate violations across multiple pages', async () => {
      mockAxeRunner.getSeverityCounts
        .mockReturnValueOnce({ critical: 1, serious: 2, moderate: 0, minor: 0 })
        .mockReturnValueOnce({ critical: 0, serious: 1, moderate: 3, minor: 2 });

      const result = await accessibilityRunner.run();

      expect(result.summary.violationsBySeverity.critical).toBe(1);
      expect(result.summary.violationsBySeverity.serious).toBe(3);
      expect(result.summary.violationsBySeverity.moderate).toBe(3);
      expect(result.summary.violationsBySeverity.minor).toBe(2);
    });

    it('should mark overall test as failed when axe violations exceed threshold', async () => {
      mockAxeRunner.checkThreshold.mockReturnValue(false);

      const result = await accessibilityRunner.run();

      expect(result.summary.passed).toBe(false);
    });

    it('should mark overall test as failed when keyboard tests fail', async () => {
      mockKeyboardTester.run.mockResolvedValue({
        testName: 'keyboard-test',
        passed: false, // Keyboard test failed
        interactions: [],
        focusOrder: [],
        trapTests: []
      });

      const result = await accessibilityRunner.run();

      expect(result.summary.passed).toBe(false);
      expect(result.summary.keyboardTestsFailed).toBe(2);
    });

    it('should count keyboard test results correctly', async () => {
      mockKeyboardTester.run
        .mockResolvedValueOnce({
          testName: 'keyboard-test-1',
          passed: true,
          interactions: [],
          focusOrder: [],
          trapTests: []
        })
        .mockResolvedValueOnce({
          testName: 'keyboard-test-2',
          passed: false,
          interactions: [],
          focusOrder: [],
          trapTests: []
        });

      const result = await accessibilityRunner.run();

      expect(result.summary.keyboardTestsPassed).toBe(1);
      expect(result.summary.keyboardTestsFailed).toBe(1);
    });

    it('should navigate to correct URLs for pages', async () => {
      await accessibilityRunner.run();

      expect(mockPage.goto).toHaveBeenCalledWith('http://localhost:3000/', { waitUntil: 'networkidle' });
      expect(mockPage.goto).toHaveBeenCalledWith('http://localhost:3000/about', { waitUntil: 'networkidle' });
    });

    it('should handle absolute URLs', async () => {
      const customConfig = {
        ...defaultConfig,
        pages: ['https://example.com/page1', 'https://example.com/page2']
      };
      accessibilityRunner = new AccessibilityRunner(customConfig);

      await accessibilityRunner.run();

      expect(mockPage.goto).toHaveBeenCalledWith('https://example.com/page1', { waitUntil: 'networkidle' });
      expect(mockPage.goto).toHaveBeenCalledWith('https://example.com/page2', { waitUntil: 'networkidle' });
    });

    it('should include duration in results', async () => {
      const result = await accessibilityRunner.run();

      expect(result.duration).toBeGreaterThanOrEqual(0); // Can be 0 in fast mock execution
      expect(typeof result.duration).toBe('number');
    });
  });

  describe('keyboard testing integration', () => {
    it('should run keyboard tests when any keyboard option is enabled', async () => {
      const result = await accessibilityRunner.run();

      expect(mockKeyboardTester.run).toHaveBeenCalledTimes(2);
      expect(result.results[0].keyboardResult).toBeDefined();
    });

    it('should skip keyboard tests when all options are disabled', async () => {
      const configNoKeyboard = {
        ...defaultConfig,
        keyboard: {
          testFocusOrder: false,
          testTrapDetection: false,
          testArrowKeyNavigation: false,
          testEscapeHandling: false,
          customSequences: []
        }
      };
      accessibilityRunner = new AccessibilityRunner(configNoKeyboard);

      const result = await accessibilityRunner.run();

      expect(mockKeyboardTester.run).not.toHaveBeenCalled();
      expect(result.results[0].keyboardResult).toBeUndefined();
    });
  });

  describe('screen reader testing', () => {
    it('should run screen reader tests when enabled', async () => {
      // Mock screen reader test data
      mockPage.evaluate.mockImplementation((fn: any) => {
        if (fn.toString().includes('aria-label')) {
          return Promise.resolve([
            {
              element: 'BUTTON',
              expectedText: 'Submit',
              actualText: 'Submit',
              role: 'button',
              properties: { 'aria-label': 'Submit' },
              success: true
            }
          ]);
        }
        if (fn.toString().includes('landmarkElements')) {
          return Promise.resolve([
            {
              type: 'main',
              label: 'Main content',
              element: 'MAIN',
              level: undefined
            }
          ]);
        }
        if (fn.toString().includes('headingElements')) {
          return Promise.resolve([
            { level: 1, text: 'Title', element: 'H1' },
            { level: 2, text: 'Subtitle', element: 'H2' }
          ]);
        }
        return Promise.resolve([]);
      });

      const result = await accessibilityRunner.run();

      expect(result.results[0].screenReaderResult).toBeDefined();
      expect(result.results[0].screenReaderResult?.announcements).toHaveLength(1);
      expect(result.results[0].screenReaderResult?.landmarkStructure).toHaveLength(1);
      expect(result.results[0].screenReaderResult?.headingStructure).toHaveLength(2);
    });

    it('should skip screen reader tests when disabled', async () => {
      const configNoScreenReader = {
        ...defaultConfig,
        screenReader: {
          testAriaLabels: false,
          testLandmarkNavigation: false,
          testImageAltText: false,
          testHeadingStructure: false,
          simulateScreenReader: false
        }
      };
      accessibilityRunner = new AccessibilityRunner(configNoScreenReader);

      const result = await accessibilityRunner.run();

      expect(result.results[0].screenReaderResult).toBeUndefined();
    });

    it('should fail when heading hierarchy is invalid', async () => {
      mockPage.evaluate.mockImplementation((fn: any) => {
        if (fn.toString().includes('headingElements')) {
          return Promise.resolve([
            { level: 1, text: 'Title', element: 'H1' },
            { level: 3, text: 'Subtitle', element: 'H3' } // Skipped H2
          ]);
        }
        if (fn.toString().includes('landmarkElements')) {
          return Promise.resolve([
            { type: 'main', label: 'Main', element: 'MAIN', level: undefined }
          ]);
        }
        return Promise.resolve([]);
      });

      const result = await accessibilityRunner.run();

      expect(result.results[0].screenReaderResult?.passed).toBe(false);
    });

    it('should pass when heading hierarchy is valid', async () => {
      mockPage.evaluate.mockImplementation((fn: any) => {
        if (fn.toString().includes('headingElements')) {
          return Promise.resolve([
            { level: 1, text: 'Title', element: 'H1' },
            { level: 2, text: 'Subtitle', element: 'H2' },
            { level: 3, text: 'Section', element: 'H3' }
          ]);
        }
        if (fn.toString().includes('landmarkElements')) {
          return Promise.resolve([
            { type: 'main', label: 'Main', element: 'MAIN', level: undefined }
          ]);
        }
        return Promise.resolve([]);
      });

      const result = await accessibilityRunner.run();

      expect(result.results[0].screenReaderResult?.passed).toBe(true);
    });
  });

  describe('report generation', () => {
    it('should generate JSON report when configured', async () => {
      const fs = require('fs');
      jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

      const configWithReport = {
        ...defaultConfig,
        output: {
          format: 'json' as const,
          path: './test-report.json'
        }
      };
      accessibilityRunner = new AccessibilityRunner(configWithReport);

      const result = await accessibilityRunner.run();

      expect(result.reportPath).toBe('./test-report.json');
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        './test-report.json',
        expect.any(String)
      );

      fs.writeFileSync.mockRestore();
    });

    it('should not generate report when output not configured', async () => {
      const fs = require('fs');
      jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

      const result = await accessibilityRunner.run();

      expect(result.reportPath).toBeUndefined();
      expect(fs.writeFileSync).not.toHaveBeenCalled();

      fs.writeFileSync.mockRestore();
    });

    it('should throw error for unsupported report formats', async () => {
      const configWithHtmlReport = {
        ...defaultConfig,
        output: {
          format: 'html' as const,
          path: './report.html'
        }
      };
      accessibilityRunner = new AccessibilityRunner(configWithHtmlReport);

      await expect(accessibilityRunner.run())
        .rejects.toThrow("Report format 'html' not yet implemented");
    });
  });

  describe('accessibility score calculation', () => {
    it('should return 100 for perfect accessibility', async () => {
      mockAxeRunner.getSeverityCounts.mockReturnValue({
        critical: 0,
        serious: 0,
        moderate: 0,
        minor: 0
      });

      const result = await accessibilityRunner.run();

      expect(result.summary.score).toBe(100);
    });

    it('should heavily penalize critical violations', async () => {
      mockAxeRunner.getSeverityCounts.mockReturnValue({
        critical: 1,
        serious: 0,
        moderate: 0,
        minor: 0
      });

      const result = await accessibilityRunner.run();

      expect(result.summary.score).toBeLessThan(90); // Critical reduces score significantly
    });

    it('should calculate weighted score across multiple severity levels', async () => {
      mockAxeRunner.getSeverityCounts
        .mockReturnValueOnce({ critical: 0, serious: 2, moderate: 3, minor: 5 })
        .mockReturnValueOnce({ critical: 0, serious: 1, moderate: 2, minor: 3 });

      const result = await accessibilityRunner.run();

      expect(result.summary.score).toBeGreaterThan(0);
      expect(result.summary.score).toBeLessThan(100);
    });
  });
});
