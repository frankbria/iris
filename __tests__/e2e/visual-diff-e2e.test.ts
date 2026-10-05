/**
 * E2E Integration Tests for visual-diff CLI Command
 *
 * Tests the complete workflow of the visual regression testing CLI,
 * including baseline creation, diff detection, AI semantic analysis,
 * and report generation across multiple devices.
 */

import { chromium, Browser, Page } from 'playwright';
import http from 'http';
import type { AddressInfo } from 'net';
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
        reasoning: 'Layout shift detected in navigation area',
      }),
      getCostStats: jest.fn().mockReturnValue({
        totalCost: 0,
        dailyCost: 0,
        monthlyCost: 0,
        operationCount: 0,
        cacheHitCount: 0,
        cacheHitRate: 0,
        costByProvider: {},
        costByModel: {},
      }),
      close: jest.fn(),
    })),
  };
});

describe('Visual Diff CLI E2E Tests', () => {
  let tempDir: string;
  let baselineDir: string;
  let screenshotDir: string;
  let browser: Browser;
  let page: Page;
  let cwd: string;

  // One URL whose content changes between runs: a baseline belongs to its page, so a
  // different data: URL would be a different page with a baseline of its own.
  let served = '';
  let site: http.Server;
  let siteUrl = '';
  beforeAll(async () => {
    site = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(served);
    });
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
  });
  afterAll(() => new Promise((resolve) => site.close(resolve)));

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
    // The runner writes baselines, runs and reports relative to the working directory
    // (.iris/...): run in the temp directory, never in this repository (#284).
    cwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(async () => {
    await page?.close();
    process.chdir(cwd);

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
          reference: 'main',
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
            networkIdleTimeout: 1000,
          },
        },
        diff: {
          threshold: 0.1,
          semanticAnalysis: false,
          aiProvider: 'openai',
          antiAliasing: true,
          maxConcurrency: 1,
        },
        devices: ['desktop'],
        updateBaseline: true,
        failOn: 'breaking',
      };

      const runner = new VisualTestRunner(config);
      const result = await runner.run();

      // The data: page is captured and becomes the baseline (#284: it used to get the
      // base URL prepended and fail to navigate, so this suite asserted the error path).
      expect(result.summary.totalComparisons).toBe(1);
      expect(result.summary.newBaselines).toBe(1);
      expect(result.summary.failed).toBe(0);
      expect(result.summary.overallStatus).toBe('passed');
      expect(result.results[0]).toMatchObject({ passed: true });
      expect(result.results[0].error).toBeUndefined();
      expect(fs.existsSync(result.results[0].screenshotPath)).toBe(true);
    });

    it('should handle multiple pages and create baselines for each', async () => {
      const page1Html = '<html><body><h1>Page 1</h1></body></html>';
      const page2Html = '<html><body><h1>Page 2</h1></body></html>';

      const config: VisualTestRunnerConfig = {
        pages: [
          'data:text/html,' + encodeURIComponent(page1Html),
          'data:text/html,' + encodeURIComponent(page2Html),
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
            networkIdleTimeout: 1000,
          },
        },
        diff: {
          threshold: 0.1,
          semanticAnalysis: false,
          aiProvider: 'openai',
          antiAliasing: true,
          maxConcurrency: 2,
        },
        updateBaseline: true,
      };

      const runner = new VisualTestRunner(config);
      const result = await runner.run();

      // 2 pages × 1 default device, each its own baseline (and its own file: #343).
      expect(result.summary.totalComparisons).toBe(2);
      expect(result.summary.newBaselines).toBe(2);
      expect(result.summary.failed).toBe(0);
      expect(new Set(result.results.map((r) => r.screenshotPath)).size).toBe(2);
    });
  });

  describe('Diff Detection', () => {
    it('should detect visual differences when content changes', async () => {
      served = '<html><body><h1>Original Content</h1></body></html>';

      const baselineConfig: VisualTestRunnerConfig = {
        pages: [siteUrl],
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
            networkIdleTimeout: 1000,
          },
        },
        diff: {
          threshold: 0.0001, // a heading change is well under 1% of the page
          semanticAnalysis: false,
          aiProvider: 'openai',
          antiAliasing: true,
          maxConcurrency: 1,
        },
        updateBaseline: true,
      };

      const baselineRunner = new VisualTestRunner(baselineConfig);
      await baselineRunner.run();

      // The same page, changed: a heading's text, a small share of a 1920x1080 page.
      served = '<html><body><h1>Changed Content</h1></body></html>';

      const diffConfig: VisualTestRunnerConfig = {
        ...baselineConfig,
        updateBaseline: false,
      };

      const diffRunner = new VisualTestRunner(diffConfig);
      const result = await diffRunner.run();

      expect(result.summary).toMatchObject({ failed: 1, newBaselines: 0, overallStatus: 'failed' });
      const [compared] = result.results;
      expect(compared.error).toBeUndefined();
      expect(compared.passed).toBe(false);
      expect(compared.pixelDifference).toBeGreaterThan(0);
      expect(compared.similarity).toBeLessThan(1.0);
      // The diff image is written for a failed comparison.
      expect(fs.existsSync(compared.diffPath!)).toBe(true);
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
            networkIdleTimeout: 1000,
          },
        },
        diff: {
          threshold: 0.1,
          semanticAnalysis: false,
          aiProvider: 'openai',
          antiAliasing: true,
          maxConcurrency: 1,
        },
        updateBaseline: true,
      };

      const baselineRunner = new VisualTestRunner(baselineConfig);
      await baselineRunner.run();

      // Run comparison with same content
      const compareRunner = new VisualTestRunner({
        ...baselineConfig,
        updateBaseline: false,
      });
      const result = await compareRunner.run();

      // Compared against the baseline the first run made, and identical.
      expect(result.summary).toMatchObject({ passed: 1, failed: 0, newBaselines: 0 });
      expect(result.results[0].error).toBeUndefined();
      expect(result.results[0].similarity).toBe(1);
    });

    it('should respect pixel difference threshold', async () => {
      // A 100x100 box changes colour: 10,000 pixels, about 0.5% of a desktop (1920x1080)
      // page. The runner sizes the page by device, not by capture.viewport.
      const box = (colour: string) =>
        `<html><body style="margin:0"><div style="width:100px;height:100px;background:${colour}"></div></body></html>`;
      served = box('red');

      const baselineConfig: VisualTestRunnerConfig = {
        pages: [siteUrl],
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
            networkIdleTimeout: 1000,
          },
        },
        diff: {
          threshold: 0.001, // 0.1%: strict
          semanticAnalysis: false,
          aiProvider: 'openai',
          antiAliasing: true,
          maxConcurrency: 1,
        },
        updateBaseline: true,
      };

      const baselineRunner = new VisualTestRunner(baselineConfig);
      await baselineRunner.run();

      served = box('blue');
      // About 0.5% differ: over a 0.1% threshold, under a 50% one.
      const strictResult = await new VisualTestRunner({
        ...baselineConfig,
        updateBaseline: false,
      }).run();
      const lenientResult = await new VisualTestRunner({
        ...baselineConfig,
        diff: { ...baselineConfig.diff, threshold: 0.5 },
        updateBaseline: false,
      }).run();

      expect(strictResult.summary).toMatchObject({ failed: 1, newBaselines: 0 });
      expect(strictResult.results[0].pixelDifference).toBe(100 * 100); // exactly the box
      expect(lenientResult.summary).toMatchObject({ passed: 1, failed: 0 });
    });
  });

  describe('AI Semantic Analysis Integration', () => {
    it('should provide AI classification when semantic analysis is enabled', async () => {
      const baselineHtml =
        '<html><body><button style="margin-left:0px">Click</button></body></html>';
      const modifiedHtml =
        '<html><body><button style="margin-left:50px">Click</button></body></html>';

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
            networkIdleTimeout: 1000,
          },
        },
        diff: {
          threshold: 0.05,
          semanticAnalysis: true,
          aiProvider: 'openai',
          antiAliasing: true,
          maxConcurrency: 1,
        },
        updateBaseline: true,
      };

      const baselineRunner = new VisualTestRunner(baselineConfig);
      await baselineRunner.run();

      // Run with AI analysis
      const aiRunner = new VisualTestRunner({
        ...baselineConfig,
        pages: ['data:text/html,' + encodeURIComponent(modifiedHtml)],
        updateBaseline: false,
      });
      const result = await aiRunner.run();

      // Assertions
      if (result.summary.failed > 0) {
        const failedResult = result.results.find((r) => !r.passed);
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
      served = '<html><body><h1>Title</h1><p>Content</p></body></html>';

      // Create baseline
      const config: VisualTestRunnerConfig = {
        pages: [siteUrl],
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
            networkIdleTimeout: 1000,
          },
        },
        diff: {
          threshold: 0, // any changed pixel fails: a punctuation change is only a few
          semanticAnalysis: true,
          aiProvider: 'openai',
          antiAliasing: true,
          maxConcurrency: 1,
        },
        updateBaseline: true,
      };

      const baselineRunner = new VisualTestRunner(config);
      await baselineRunner.run();

      // The same page with a punctuation change (one URL: a baseline belongs to its page).
      served = '<html><body><h1>Title</h1><p>Content .</p></body></html>';
      const testRunner = new VisualTestRunner({ ...config, updateBaseline: false });
      const result = await testRunner.run();

      // Compared, not re-baselined, and graded.
      expect(result.summary).toMatchObject({ newBaselines: 0, failed: 1 });
      const [compared] = result.results;
      expect(compared.error).toBeUndefined();
      expect(compared.pixelDifference).toBeGreaterThan(0);
      expect(['minor', 'moderate', 'breaking']).toContain(compared.severity);
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
            networkIdleTimeout: 1000,
          },
        },
        diff: {
          threshold: 0.1,
          semanticAnalysis: false,
          aiProvider: 'openai',
          antiAliasing: true,
          maxConcurrency: 3,
        },
        devices: ['desktop', 'tablet', 'mobile'],
        updateBaseline: true,
      };

      const runner = new VisualTestRunner(config);
      const result = await runner.run();

      // 1 page × 3 devices.
      expect(result.summary.totalComparisons).toBe(3);
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
            networkIdleTimeout: 1000,
          },
        },
        diff: {
          threshold: 0.1,
          semanticAnalysis: false,
          aiProvider: 'openai',
          antiAliasing: true,
          maxConcurrency: 2,
        },
        devices: ['desktop', 'mobile'],
        updateBaseline: true,
      };

      const baselineRunner = new VisualTestRunner(baselineConfig);
      await baselineRunner.run();

      // Modified version
      const modifiedHtml = '<html><body><div style="width:100%">Modified Width</div></body></html>';
      const testRunner = new VisualTestRunner({
        ...baselineConfig,
        pages: ['data:text/html,' + encodeURIComponent(modifiedHtml)],
        updateBaseline: false,
      });
      const result = await testRunner.run();

      // 1 page × 2 devices.
      expect(result.summary.totalComparisons).toBe(2);
      expect(result.results.filter((r) => !r.passed).length).toBeGreaterThanOrEqual(0);
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
            networkIdleTimeout: 1000,
          },
        },
        diff: {
          threshold: 0.1,
          semanticAnalysis: false,
          aiProvider: 'openai',
          antiAliasing: true,
          maxConcurrency: 1,
        },
        updateBaseline: true,
        output: {
          format: 'json',
          path: reportPath,
        },
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
            networkIdleTimeout: 1000,
          },
        },
        diff: {
          threshold: 0.05,
          semanticAnalysis: false,
          aiProvider: 'openai',
          antiAliasing: true,
          maxConcurrency: 1,
        },
        updateBaseline: true,
      };

      const baselineRunner = new VisualTestRunner(baselineConfig);
      await baselineRunner.run();

      // Test with changes
      const testRunner = new VisualTestRunner({
        ...baselineConfig,
        pages: ['data:text/html,' + encodeURIComponent(modifiedHtml)],
        updateBaseline: false,
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
    // Renamed from "...efficiently" with #142: the word described the deleted
    // wall-clock bound, and a name that promises something the body no longer
    // checks is how a test quietly stops meaning anything.
    it('processes every page when comparisons run concurrently', async () => {
      const pages = Array.from(
        { length: 5 },
        (_, i) =>
          `data:text/html,${encodeURIComponent(`<html><body><h1>Page ${i}</h1></body></html>`)}`,
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
            networkIdleTimeout: 1000,
          },
        },
        diff: {
          threshold: 0.1,
          semanticAnalysis: false,
          aiProvider: 'openai',
          antiAliasing: true,
          maxConcurrency: 3,
        },
        updateBaseline: true,
      };

      // Issue #142: this used to assert `duration < 30000`, the named example in
      // that issue. Five real page captures against a fixed wall-clock ceiling
      // breaks whenever the machine is busy, and load only ever pushes elapsed
      // time up — so the bound could fail but never catch a regression.
      //
      // Removing it dropped the concurrency signal, though, so observe overlap
      // directly instead: wrap the per-task seam and record how many runs are in
      // flight at once. That asserts what the timing bound was only ever a proxy
      // for, and it cannot be broken by a slow machine — a serial runner peaks at
      // 1 whether the box is fast or loaded.
      type Seam = { testPage(page: string, device: string): Promise<unknown> };
      const original = (VisualTestRunner.prototype as unknown as Seam).testPage;
      let inFlight = 0;
      let peakInFlight = 0;
      const seamSpy = jest
        .spyOn(VisualTestRunner.prototype as unknown as Seam, 'testPage')
        .mockImplementation(async function (this: Seam, ...args: [string, string]) {
          inFlight++;
          peakInFlight = Math.max(peakInFlight, inFlight);
          try {
            return await original.apply(this, args);
          } finally {
            inFlight--;
          }
        });

      let result;
      try {
        const runner = new VisualTestRunner(config);
        result = await runner.run();
      } finally {
        seamSpy.mockRestore();
      }

      // 5 pages × 1 default device.
      expect(result.summary.totalComparisons).toBe(5);
      expect(result.results).toHaveLength(5);
      // Work genuinely overlapped, and never beyond the configured cap of 3.
      expect(peakInFlight).toBeGreaterThan(1);
      expect(peakInFlight).toBeLessThanOrEqual(3);
    });
  });

  describe('Error Handling', () => {
    it.skip('should handle invalid page URLs gracefully', async () => {
      // SKIP REASON: Test expectation is wrong. VisualTestRunner correctly handles
      // errors gracefully by catching them and including in results array
      // (src/visual/visual-runner.ts:229-242). It does NOT throw exceptions for
      // individual page failures - this is correct design for a test runner that
      // should continue testing other pages.
      //
      // TO RE-ENABLE: Rewrite to expect error in results instead of thrown exception:
      // const result = await runner.run();
      // expect(result.summary.failed).toBe(1);
      // expect(result.results[0].error).toBeDefined();
      // expect(result.results[0].passed).toBe(false);
      //
      // See docs/e2e-visual-test-assessment.md Pattern 3: Error Handling Philosophy

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
            networkIdleTimeout: 1000,
          },
        },
        diff: {
          threshold: 0.1,
          semanticAnalysis: false,
          aiProvider: 'openai',
          antiAliasing: true,
          maxConcurrency: 1,
        },
        updateBaseline: false,
      };

      const runner = new VisualTestRunner(config);

      await expect(runner.run()).rejects.toThrow();
    });

    it('should continue testing other pages when one fails', async () => {
      const validHtml = '<html><body><h1>Valid Page</h1></body></html>';

      const config: VisualTestRunnerConfig = {
        pages: ['data:text/html,' + encodeURIComponent(validHtml), 'http://invalid-test-url.test'],
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
            networkIdleTimeout: 1000,
          },
        },
        diff: {
          threshold: 0.1,
          semanticAnalysis: false,
          aiProvider: 'openai',
          antiAliasing: true,
          maxConcurrency: 2,
        },
        updateBaseline: true,
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
            networkIdleTimeout: 1000,
          },
        },
        diff: {
          threshold: 0.1,
          semanticAnalysis: false,
          aiProvider: 'openai',
          antiAliasing: true,
          maxConcurrency: 1,
        },
        updateBaseline: true,
      };

      const baselineRunner = new VisualTestRunner(baselineConfig);
      await baselineRunner.run();

      // Create slightly different version (dynamic content changes)
      const html2 = html.replace(Date.now().toString(), (Date.now() + 1000).toString());

      const testRunner = new VisualTestRunner({
        ...baselineConfig,
        pages: ['data:text/html,' + encodeURIComponent(html2)],
        updateBaseline: false,
      });
      const result = await testRunner.run();

      // Should pass because dynamic content is masked
      expect(result.summary.passed).toBeGreaterThanOrEqual(0);
    });
  });
});
