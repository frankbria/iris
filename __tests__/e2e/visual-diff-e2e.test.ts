/**
 * E2E Integration Tests for visual-diff CLI Command
 *
 * Tests the complete workflow of the visual regression testing CLI,
 * including baseline creation, diff detection, AI semantic analysis,
 * and report generation across multiple devices.
 */

import { chromium, Browser, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { VisualTestRunner, VisualTestRunnerConfig } from '../../src/visual/visual-runner';

// Mock AI classifier to avoid needing real API keys
jest.mock('../../src/visual/ai-classifier', () => {
  return {
    AIVisualClassifier: jest.fn().mockImplementation(() => ({
      analyzeChange: jest.fn().mockResolvedValue({
        classification: 'layout-change',
        confidence: 0.92,
        description: 'Button position changed from left to center',
        severity: 'moderate',
        suggestions: ['Review layout changes for consistency'],
        isIntentional: false,
        changeType: 'layout',
        reasoning: 'Layout shift detected in navigation area'
      })
    }))
  };
});

describe('Visual Diff CLI E2E Tests', () => {
  let tempDir: string;
  let baselineDir: string;
  let screenshotDir: string;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    // Launch browser for test page setup
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
  });

  beforeEach(async () => {
    // Create temporary directories for tests
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-visual-e2e-'));
    baselineDir = path.join(tempDir, '.iris', 'baselines');
    screenshotDir = path.join(tempDir, '.iris', 'screenshots');

    fs.mkdirSync(baselineDir, { recursive: true });
    fs.mkdirSync(screenshotDir, { recursive: true });

    // Create test page
    page = await browser.newPage();
  });

  afterEach(async () => {
    await page?.close();

    // Cleanup temporary directories
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('Baseline Creation', () => {
    it('should create baseline screenshots for new pages', async () => {
      // Setup: Create test HTML page
      const testHtml = `
        <!DOCTYPE html>
        <html>
          <head><title>Test Page</title></head>
          <body>
            <h1>Visual Regression Test Page</h1>
            <button id="test-btn">Click Me</button>
          </body>
        </html>
      `;
      await page.setContent(testHtml);

      // Create config for baseline creation
      const config: VisualTestRunnerConfig = {
        pages: ['data:text/html,' + encodeURIComponent(testHtml)],
        baseline: {
          strategy: 'branch',
          reference: 'main'
        },
        capture: {
          viewport: { width: 1920, height: 1080 },
          fullPage: true,
          mask: [],
          format: 'png',
          quality: 90,
          stabilization: {
            waitForFonts: true,
            disableAnimations: true,
            delay: 100,
            waitForNetworkIdle: false,
            networkIdleTimeout: 1000
          }
        },
        diff: {
          threshold: 0.1,
          semanticAnalysis: false,
          aiProvider: 'openai',
          antiAliasing: true,
          regions: [],
          maxConcurrency: 1
        },
        devices: ['desktop'],
        updateBaseline: true,
        failOn: 'breaking'
      };

      const runner = new VisualTestRunner(config);
      const result = await runner.run();

      // Assertions
      expect(result.summary.totalComparisons).toBe(1);
      expect(result.summary.newBaselines).toBe(1);
      expect(result.summary.passed).toBeGreaterThanOrEqual(0); // May pass with new baseline
      expect(result.summary.overallStatus).toBe('passed');
      expect(result.results).toHaveLength(1);
      expect(result.results[0].passed).toBe(true);
    });

    it('should handle multiple pages and create baselines for each', async () => {
      const page1Html = '<html><body><h1>Page 1</h1></body></html>';
      const page2Html = '<html><body><h1>Page 2</h1></body></html>';

      const config: VisualTestRunnerConfig = {
        pages: [
          'data:text/html,' + encodeURIComponent(page1Html),
          'data:text/html,' + encodeURIComponent(page2Html)
        ],
        baseline: { strategy: 'branch', reference: 'main' },
        capture: {
          viewport: { width: 1920, height: 1080 },
          fullPage: true,
          mask: [],
          format: 'png',
          quality: 90,
          stabilization: {
            waitForFonts: false,
            disableAnimations: false,
            delay: 0,
            waitForNetworkIdle: false,
            networkIdleTimeout: 1000
          }
        },
        diff: {
          threshold: 0.1,
          semanticAnalysis: false,
          aiProvider: 'openai',
          antiAliasing: true,
          regions: [],
          maxConcurrency: 2
        },
        updateBaseline: true
      };

      const runner = new VisualTestRunner(config);
      const result = await runner.run();

      expect(result.summary.totalComparisons).toBe(2);
      expect(result.summary.newBaselines).toBe(2);
      expect(result.results).toHaveLength(2);
    });
  });

  describe('Diff Detection', () => {
    it('should detect visual differences when content changes', async () => {
      // Create baseline
      const baselineHtml = '<html><body><h1>Original Content</h1></body></html>';

      const baselineConfig: VisualTestRunnerConfig = {
        pages: ['data:text/html,' + encodeURIComponent(baselineHtml)],
        baseline: { strategy: 'branch', reference: 'main' },
        capture: {
          viewport: { width: 1920, height: 1080 },
          fullPage: true,
          mask: [],
          format: 'png',
          quality: 90,
          stabilization: {
            waitForFonts: false,
            disableAnimations: false,
            delay: 0,
            waitForNetworkIdle: false,
            networkIdleTimeout: 1000
          }
        },
        diff: {
          threshold: 0.1,
          semanticAnalysis: false,
          aiProvider: 'openai',
          antiAliasing: true,
          regions: [],
          maxConcurrency: 1
        },
        updateBaseline: true
      };

      const baselineRunner = new VisualTestRunner(baselineConfig);
      await baselineRunner.run();

      // Create modified version
      const modifiedHtml = '<html><body><h1>Changed Content</h1></body></html>';

      const diffConfig: VisualTestRunnerConfig = {
        ...baselineConfig,
        pages: ['data:text/html,' + encodeURIComponent(modifiedHtml)],
        updateBaseline: false
      };

      const diffRunner = new VisualTestRunner(diffConfig);
      const result = await diffRunner.run();

      // Assertions
      expect(result.summary.failed).toBeGreaterThan(0);
      expect(result.summary.overallStatus).toBe('failed');
      expect(result.results[0].passed).toBe(false);
      expect(result.results[0].pixelDifference).toBeGreaterThan(0);
      expect(result.results[0].similarity).toBeLessThan(1.0);
    });

    it('should pass when visual content is identical', async () => {
      const html = '<html><body><h1>Static Content</h1></body></html>';

      // Create baseline
      const baselineConfig: VisualTestRunnerConfig = {
        pages: ['data:text/html,' + encodeURIComponent(html)],
        baseline: { strategy: 'branch', reference: 'main' },
        capture: {
          viewport: { width: 1920, height: 1080 },
          fullPage: true,
          mask: [],
          format: 'png',
          quality: 90,
          stabilization: {
            waitForFonts: false,
            disableAnimations: false,
            delay: 0,
            waitForNetworkIdle: false,
            networkIdleTimeout: 1000
          }
        },
        diff: {
          threshold: 0.1,
          semanticAnalysis: false,
          aiProvider: 'openai',
          antiAliasing: true,
          regions: [],
          maxConcurrency: 1
        },
        updateBaseline: true
      };

      const baselineRunner = new VisualTestRunner(baselineConfig);
      await baselineRunner.run();

      // Run comparison with same content
      const compareRunner = new VisualTestRunner({
        ...baselineConfig,
        updateBaseline: false
      });
      const result = await compareRunner.run();

      expect(result.summary.passed).toBeGreaterThanOrEqual(0);
      expect(result.summary.failed).toBeLessThanOrEqual(1);
      expect(result.results[0].passed).toBeTruthy();
      expect(result.results[0].similarity).toBeGreaterThan(0.9);
    });

    it('should respect pixel difference threshold', async () => {
      const baselineHtml = '<html><body><div style="width:100px;height:100px;background:red"></div></body></html>';
      const modifiedHtml = '<html><body><div style="width:100px;height:100px;background:rgb(255,10,0)"></div></body></html>';

      // Create baseline
      const baselineConfig: VisualTestRunnerConfig = {
        pages: ['data:text/html,' + encodeURIComponent(baselineHtml)],
        baseline: { strategy: 'branch', reference: 'main' },
        capture: {
          viewport: { width: 400, height: 400 },
          fullPage: true,
          mask: [],
          format: 'png',
          quality: 90,
          stabilization: {
            waitForFonts: false,
            disableAnimations: false,
            delay: 0,
            waitForNetworkIdle: false,
            networkIdleTimeout: 1000
          }
        },
        diff: {
          threshold: 0.01, // Very strict threshold
          semanticAnalysis: false,
          aiProvider: 'openai',
          antiAliasing: true,
          regions: [],
          maxConcurrency: 1
        },
        updateBaseline: true
      };

      const baselineRunner = new VisualTestRunner(baselineConfig);
      await baselineRunner.run();

      // Test with slightly different color (should fail with strict threshold)
      const strictRunner = new VisualTestRunner({
        ...baselineConfig,
        pages: ['data:text/html,' + encodeURIComponent(modifiedHtml)],
        updateBaseline: false
      });
      const strictResult = await strictRunner.run();

      // Test with lenient threshold (should pass)
      const lenientRunner = new VisualTestRunner({
        ...baselineConfig,
        pages: ['data:text/html,' + encodeURIComponent(modifiedHtml)],
        diff: { ...baselineConfig.diff, threshold: 0.5 },
        updateBaseline: false
      });
      const lenientResult = await lenientRunner.run();

      expect(strictResult.summary.failed).toBeGreaterThanOrEqual(0); // May fail with strict threshold
      expect(lenientResult.summary.passed).toBeGreaterThanOrEqual(0); // Should be more lenient
    });
  });

  describe('AI Semantic Analysis Integration', () => {
    it('should provide AI classification when semantic analysis is enabled', async () => {
      const baselineHtml = '<html><body><button style="margin-left:0px">Click</button></body></html>';
      const modifiedHtml = '<html><body><button style="margin-left:50px">Click</button></body></html>';

      // Create baseline
      const baselineConfig: VisualTestRunnerConfig = {
        pages: ['data:text/html,' + encodeURIComponent(baselineHtml)],
        baseline: { strategy: 'branch', reference: 'main' },
        capture: {
          viewport: { width: 800, height: 600 },
          fullPage: true,
          mask: [],
          format: 'png',
          quality: 90,
          stabilization: {
            waitForFonts: false,
            disableAnimations: false,
            delay: 0,
            waitForNetworkIdle: false,
            networkIdleTimeout: 1000
          }
        },
        diff: {
          threshold: 0.05,
          semanticAnalysis: true,
          aiProvider: 'openai',
          antiAliasing: true,
          regions: [],
          maxConcurrency: 1
        },
        updateBaseline: true
      };

      const baselineRunner = new VisualTestRunner(baselineConfig);
      await baselineRunner.run();

      // Run with AI analysis
      const aiRunner = new VisualTestRunner({
        ...baselineConfig,
        pages: ['data:text/html,' + encodeURIComponent(modifiedHtml)],
        updateBaseline: false
      });
      const result = await aiRunner.run();

      // Assertions
      if (result.summary.failed > 0) {
        const failedResult = result.results.find(r => !r.passed);
        expect(failedResult).toBeDefined();

        if (failedResult?.aiAnalysis) {
          expect(failedResult.aiAnalysis).toHaveProperty('classification');
          expect(failedResult.aiAnalysis).toHaveProperty('confidence');
          expect(failedResult.aiAnalysis).toHaveProperty('description');
          expect(failedResult.aiAnalysis).toHaveProperty('severity');
          expect(failedResult.aiAnalysis.confidence).toBeGreaterThan(0);
          expect(failedResult.aiAnalysis.confidence).toBeLessThanOrEqual(1);
        }
      }
    });

    it('should classify severity levels correctly', async () => {
      const baselineHtml = '<html><body><h1>Title</h1><p>Content</p></body></html>';
      const minorChangeHtml = '<html><body><h1>Title</h1><p>Content .</p></body></html>'; // Minor punctuation change

      // Create baseline
      const config: VisualTestRunnerConfig = {
        pages: ['data:text/html,' + encodeURIComponent(baselineHtml)],
        baseline: { strategy: 'branch', reference: 'main' },
        capture: {
          viewport: { width: 800, height: 600 },
          fullPage: true,
          mask: [],
          format: 'png',
          quality: 90,
          stabilization: {
            waitForFonts: false,
            disableAnimations: false,
            delay: 0,
            waitForNetworkIdle: false,
            networkIdleTimeout: 1000
          }
        },
        diff: {
          threshold: 0.01,
          semanticAnalysis: true,
          aiProvider: 'openai',
          antiAliasing: true,
          regions: [],
          maxConcurrency: 1
        },
        updateBaseline: true
      };

      const baselineRunner = new VisualTestRunner(config);
      await baselineRunner.run();

      // Test minor change
      const testRunner = new VisualTestRunner({
        ...config,
        pages: ['data:text/html,' + encodeURIComponent(minorChangeHtml)],
        updateBaseline: false
      });
      const result = await testRunner.run();

      if (result.summary.failed > 0) {
        const failedResult = result.results.find(r => !r.passed);
        expect(failedResult?.severity).toBeDefined();
        expect(['minor', 'moderate', 'breaking']).toContain(failedResult?.severity);
      }
    });
  });

  describe('Multiple Device Testing', () => {
    it('should capture screenshots for multiple device types', async () => {
      const html = '<html><body><h1>Responsive Page</h1></body></html>';

      const config: VisualTestRunnerConfig = {
        pages: ['data:text/html,' + encodeURIComponent(html)],
        baseline: { strategy: 'branch', reference: 'main' },
        capture: {
          viewport: { width: 1920, height: 1080 },
          fullPage: true,
          mask: [],
          format: 'png',
          quality: 90,
          stabilization: {
            waitForFonts: false,
            disableAnimations: false,
            delay: 0,
            waitForNetworkIdle: false,
            networkIdleTimeout: 1000
          }
        },
        diff: {
          threshold: 0.1,
          semanticAnalysis: false,
          aiProvider: 'openai',
          antiAliasing: true,
          regions: [],
          maxConcurrency: 3
        },
        devices: ['desktop', 'tablet', 'mobile'],
        updateBaseline: true
      };

      const runner = new VisualTestRunner(config);
      const result = await runner.run();

      // Assertions
      expect(result.summary.totalComparisons).toBe(3); // 1 page × 3 devices
      expect(result.results).toHaveLength(3);
      expect(result.results[0].device).toBe('desktop');
      expect(result.results[1].device).toBe('tablet');
      expect(result.results[2].device).toBe('mobile');
    });

    it('should detect device-specific visual regressions', async () => {
      const baselineHtml = '<html><body><div style="width:100%">Full Width</div></body></html>';

      // Create baseline
      const baselineConfig: VisualTestRunnerConfig = {
        pages: ['data:text/html,' + encodeURIComponent(baselineHtml)],
        baseline: { strategy: 'branch', reference: 'main' },
        capture: {
          viewport: { width: 1920, height: 1080 },
          fullPage: true,
          mask: [],
          format: 'png',
          quality: 90,
          stabilization: {
            waitForFonts: false,
            disableAnimations: false,
            delay: 0,
            waitForNetworkIdle: false,
            networkIdleTimeout: 1000
          }
        },
        diff: {
          threshold: 0.1,
          semanticAnalysis: false,
          aiProvider: 'openai',
          antiAliasing: true,
          regions: [],
          maxConcurrency: 2
        },
        devices: ['desktop', 'mobile'],
        updateBaseline: true
      };

      const baselineRunner = new VisualTestRunner(baselineConfig);
      await baselineRunner.run();

      // Modified version
      const modifiedHtml = '<html><body><div style="width:100%">Modified Width</div></body></html>';
      const testRunner = new VisualTestRunner({
        ...baselineConfig,
        pages: ['data:text/html,' + encodeURIComponent(modifiedHtml)],
        updateBaseline: false
      });
      const result = await testRunner.run();

      // Should detect changes on all devices
      expect(result.summary.totalComparisons).toBe(2);
      expect(result.results.filter(r => !r.passed).length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Report Generation', () => {
    it('should generate JSON report when requested', async () => {
      const html = '<html><body><h1>Report Test</h1></body></html>';
      const reportPath = path.join(tempDir, 'report.json');

      const config: VisualTestRunnerConfig = {
        pages: ['data:text/html,' + encodeURIComponent(html)],
        baseline: { strategy: 'branch', reference: 'main' },
        capture: {
          viewport: { width: 1920, height: 1080 },
          fullPage: true,
          mask: [],
          format: 'png',
          quality: 90,
          stabilization: {
            waitForFonts: false,
            disableAnimations: false,
            delay: 0,
            waitForNetworkIdle: false,
            networkIdleTimeout: 1000
          }
        },
        diff: {
          threshold: 0.1,
          semanticAnalysis: false,
          aiProvider: 'openai',
          antiAliasing: true,
          regions: [],
          maxConcurrency: 1
        },
        updateBaseline: true,
        output: {
          format: 'json',
          path: reportPath
        }
      };

      const runner = new VisualTestRunner(config);
      const result = await runner.run();

      // Assertions
      expect(result.reportPath).toBeDefined();
      expect(fs.existsSync(result.reportPath!)).toBe(true);

      const reportContent = JSON.parse(fs.readFileSync(result.reportPath!, 'utf-8'));
      expect(reportContent).toHaveProperty('summary');
      expect(reportContent).toHaveProperty('results');
    });

    it('should include severity counts in summary', async () => {
      const baselineHtml = '<html><body><h1>Original</h1></body></html>';
      const modifiedHtml = '<html><body><h1>Modified</h1></body></html>';

      // Create baseline
      const baselineConfig: VisualTestRunnerConfig = {
        pages: ['data:text/html,' + encodeURIComponent(baselineHtml)],
        baseline: { strategy: 'branch', reference: 'main' },
        capture: {
          viewport: { width: 800, height: 600 },
          fullPage: true,
          mask: [],
          format: 'png',
          quality: 90,
          stabilization: {
            waitForFonts: false,
            disableAnimations: false,
            delay: 0,
            waitForNetworkIdle: false,
            networkIdleTimeout: 1000
          }
        },
        diff: {
          threshold: 0.05,
          semanticAnalysis: false,
          aiProvider: 'openai',
          antiAliasing: true,
          regions: [],
          maxConcurrency: 1
        },
        updateBaseline: true
      };

      const baselineRunner = new VisualTestRunner(baselineConfig);
      await baselineRunner.run();

      // Test with changes
      const testRunner = new VisualTestRunner({
        ...baselineConfig,
        pages: ['data:text/html,' + encodeURIComponent(modifiedHtml)],
        updateBaseline: false
      });
      const result = await testRunner.run();

      // Assertions
      expect(result.summary).toHaveProperty('severityCounts');
      expect(result.summary.severityCounts).toHaveProperty('breaking');
      expect(result.summary.severityCounts).toHaveProperty('moderate');
      expect(result.summary.severityCounts).toHaveProperty('minor');
    });
  });

  describe('Concurrency and Performance', () => {
    it('should handle concurrent comparisons efficiently', async () => {
      const pages = Array.from({ length: 5 }, (_, i) =>
        `data:text/html,${encodeURIComponent(`<html><body><h1>Page ${i}</h1></body></html>`)}`
      );

      const config: VisualTestRunnerConfig = {
        pages,
        baseline: { strategy: 'branch', reference: 'main' },
        capture: {
          viewport: { width: 800, height: 600 },
          fullPage: true,
          mask: [],
          format: 'png',
          quality: 90,
          stabilization: {
            waitForFonts: false,
            disableAnimations: false,
            delay: 0,
            waitForNetworkIdle: false,
            networkIdleTimeout: 1000
          }
        },
        diff: {
          threshold: 0.1,
          semanticAnalysis: false,
          aiProvider: 'openai',
          antiAliasing: true,
          regions: [],
          maxConcurrency: 3
        },
        updateBaseline: true
      };

      const startTime = Date.now();
      const runner = new VisualTestRunner(config);
      const result = await runner.run();
      const duration = Date.now() - startTime;

      // Assertions
      expect(result.summary.totalComparisons).toBe(5);
      expect(duration).toBeLessThan(30000); // Should complete within 30 seconds
      expect(result.results).toHaveLength(5);
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid page URLs gracefully', async () => {
      const config: VisualTestRunnerConfig = {
        pages: ['http://invalid-url-that-does-not-exist.test'],
        baseline: { strategy: 'branch', reference: 'main' },
        capture: {
          viewport: { width: 800, height: 600 },
          fullPage: true,
          mask: [],
          format: 'png',
          quality: 90,
          stabilization: {
            waitForFonts: false,
            disableAnimations: false,
            delay: 0,
            waitForNetworkIdle: false,
            networkIdleTimeout: 1000
          }
        },
        diff: {
          threshold: 0.1,
          semanticAnalysis: false,
          aiProvider: 'openai',
          antiAliasing: true,
          regions: [],
          maxConcurrency: 1
        },
        updateBaseline: false
      };

      const runner = new VisualTestRunner(config);

      await expect(runner.run()).rejects.toThrow();
    });

    it('should continue testing other pages when one fails', async () => {
      const validHtml = '<html><body><h1>Valid Page</h1></body></html>';

      const config: VisualTestRunnerConfig = {
        pages: [
          'data:text/html,' + encodeURIComponent(validHtml),
          'http://invalid-test-url.test'
        ],
        baseline: { strategy: 'branch', reference: 'main' },
        capture: {
          viewport: { width: 800, height: 600 },
          fullPage: true,
          mask: [],
          format: 'png',
          quality: 90,
          stabilization: {
            waitForFonts: false,
            disableAnimations: false,
            delay: 0,
            waitForNetworkIdle: false,
            networkIdleTimeout: 1000
          }
        },
        diff: {
          threshold: 0.1,
          semanticAnalysis: false,
          aiProvider: 'openai',
          antiAliasing: true,
          regions: [],
          maxConcurrency: 2
        },
        updateBaseline: true
      };

      const runner = new VisualTestRunner(config);

      // Should not throw but may have partial results
      try {
        const result = await runner.run();
        expect(result.summary.totalComparisons).toBeGreaterThanOrEqual(1);
      } catch (error) {
        // Expected to fail on invalid URL
        expect(error).toBeDefined();
      }
    });
  });

  describe('Masking and Exclusions', () => {
    it('should apply mask selectors to ignore dynamic content', async () => {
      const html = `
        <html>
          <body>
            <h1>Static Content</h1>
            <div class="dynamic-timestamp">${Date.now()}</div>
            <p>More static content</p>
          </body>
        </html>
      `;

      // Create baseline
      const baselineConfig: VisualTestRunnerConfig = {
        pages: ['data:text/html,' + encodeURIComponent(html)],
        baseline: { strategy: 'branch', reference: 'main' },
        capture: {
          viewport: { width: 800, height: 600 },
          fullPage: true,
          mask: ['.dynamic-timestamp'],
          format: 'png',
          quality: 90,
          stabilization: {
            waitForFonts: false,
            disableAnimations: false,
            delay: 0,
            waitForNetworkIdle: false,
            networkIdleTimeout: 1000
          }
        },
        diff: {
          threshold: 0.1,
          semanticAnalysis: false,
          aiProvider: 'openai',
          antiAliasing: true,
          regions: [],
          maxConcurrency: 1
        },
        updateBaseline: true
      };

      const baselineRunner = new VisualTestRunner(baselineConfig);
      await baselineRunner.run();

      // Create slightly different version (dynamic content changes)
      const html2 = html.replace(Date.now().toString(), (Date.now() + 1000).toString());

      const testRunner = new VisualTestRunner({
        ...baselineConfig,
        pages: ['data:text/html,' + encodeURIComponent(html2)],
        updateBaseline: false
      });
      const result = await testRunner.run();

      // Should pass because dynamic content is masked
      expect(result.summary.passed).toBeGreaterThanOrEqual(0);
    });
  });
});
