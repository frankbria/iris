/**
 * VisualTestRunner - Orchestrates visual regression testing workflows
 *
 * This module provides the high-level orchestration for running visual regression tests,
 * coordinating between capture, diff, baseline, and AI classification engines.
 */

import * as path from 'path';
import { chromium, Browser, Page } from 'playwright';
import { VisualCaptureEngine } from './capture';
import { VisualDiffEngine } from './diff';
import { BaselineManager } from './baseline';
import { AIVisualClassifier } from './ai-classifier';
import { StorageManager } from './storage';
import type { AIProvider } from './ai-classifier';

export interface VisualTestRunnerConfig {
  pages: string[];
  baseline: {
    strategy: 'branch' | 'commit' | 'tag';
    reference: string;
  };
  capture: {
    viewport: { width: number; height: number };
    fullPage: boolean;
    mask: string[];
    format: 'png' | 'jpeg';
    quality: number;
    stabilization: {
      waitForFonts: boolean;
      disableAnimations: boolean;
      delay: number;
      waitForNetworkIdle: boolean;
      networkIdleTimeout: number;
    };
  };
  diff: {
    threshold: number;
    semanticAnalysis: boolean;
    aiProvider: AIProvider;
    antiAliasing: boolean;
    regions: Array<{
      name: string;
      selector: string;
      weight: number;
    }>;
    maxConcurrency: number;
  };
  devices?: string[];
  updateBaseline?: boolean;
  failOn?: 'minor' | 'moderate' | 'breaking';
  output?: {
    format: 'html' | 'json' | 'junit';
    path?: string;
  };
}

export interface VisualTestResult {
  summary: {
    totalComparisons: number;
    passed: number;
    failed: number;
    newBaselines: number;
    overallStatus: string;
    severityCounts: {
      breaking?: number;
      moderate?: number;
      minor?: number;
    };
  };
  results: Array<{
    page: string;
    device: string;
    passed: boolean;
    similarity: number;
    pixelDifference: number;
    threshold: number;
    severity?: 'minor' | 'moderate' | 'breaking';
    aiAnalysis?: {
      classification: string;
      confidence: number;
      description: string;
      severity: string;
    };
    screenshotPath: string;
    baselinePath?: string;
    diffPath?: string;
  }>;
  reportPath?: string;
  duration: number;
}

/**
 * VisualTestRunner orchestrates the complete visual regression testing workflow
 */
export class VisualTestRunner {
  private config: VisualTestRunnerConfig;
  private captureEngine: VisualCaptureEngine;
  private diffEngine: VisualDiffEngine;
  private baselineManager: BaselineManager;
  private storageManager: StorageManager;
  private aiClassifier?: AIVisualClassifier;
  private browser?: Browser;

  constructor(config: VisualTestRunnerConfig) {
    this.config = config;

    // Initialize engines
    this.captureEngine = new VisualCaptureEngine();
    this.diffEngine = new VisualDiffEngine();
    this.baselineManager = new BaselineManager('.iris/baselines');
    this.storageManager = new StorageManager('.iris/screenshots');

    // Initialize AI classifier if semantic analysis is enabled
    if (config.diff.semanticAnalysis) {
      this.aiClassifier = new AIVisualClassifier({
        provider: config.diff.aiProvider,
        model: config.diff.aiProvider === 'openai' ? 'gpt-4-vision-preview' : 'claude-3-opus-20240229',
        maxTokens: 1024,
        temperature: 0.1
      });
    }
  }

  /**
   * Run visual regression tests for all configured pages and devices
   */
  async run(): Promise<VisualTestResult> {
    const startTime = Date.now();
    const results: VisualTestResult['results'] = [];
    const summary = {
      totalComparisons: 0,
      passed: 0,
      failed: 0,
      newBaselines: 0,
      overallStatus: 'passed',
      severityCounts: {
        breaking: 0,
        moderate: 0,
        minor: 0
      }
    };

    try {
      // Launch browser
      this.browser = await chromium.launch({
        headless: true
      });

      const devices = this.config.devices || ['desktop'];

      // Build test tasks (page-device combinations)
      const testTasks: Array<{ page: string; device: string }> = [];
      for (const pagePattern of this.config.pages) {
        for (const device of devices) {
          testTasks.push({ page: pagePattern, device });
        }
      }

      // Run tests in parallel with concurrency control
      const concurrency = this.config.diff.maxConcurrency || 3;
      const testResults = await this.runTestsInParallel(testTasks, concurrency);

      // Process results and update summary
      for (const result of testResults) {
        results.push(result);
        summary.totalComparisons++;

        if (result.passed) {
          summary.passed++;
        } else {
          summary.failed++;

          // Track severity counts
          if (result.severity) {
            summary.severityCounts[result.severity] =
              (summary.severityCounts[result.severity] || 0) + 1;
          }
        }

        // Check if this was a new baseline
        if (!result.baselinePath) {
          summary.newBaselines++;
        }
      }

      // Determine overall status
      summary.overallStatus = summary.failed > 0 ? 'failed' : 'passed';

      const duration = Date.now() - startTime;

      // Generate report if requested
      let reportPath: string | undefined;
      if (this.config.output?.format) {
        reportPath = await this.generateReport(results, summary);
      }

      return {
        summary,
        results,
        reportPath,
        duration
      };

    } finally {
      // Cleanup browser
      if (this.browser) {
        await this.browser.close();
      }
    }
  }

  /**
   * Run tests in parallel with concurrency control
   */
  private async runTestsInParallel(
    tasks: Array<{ page: string; device: string }>,
    concurrency: number
  ): Promise<VisualTestResult['results']> {
    const results: VisualTestResult['results'] = [];
    const executing: Promise<void>[] = [];

    for (const task of tasks) {
      const promise = this.testPage(task.page, task.device)
        .then(result => {
          results.push(result);
        })
        .catch(error => {
          // Handle test errors gracefully
          results.push({
            page: task.page,
            device: task.device,
            passed: false,
            similarity: 0,
            pixelDifference: 1,
            threshold: this.config.diff.threshold,
            severity: 'breaking',
            screenshotPath: '',
            error: error.message
          } as any);
        });

      executing.push(promise);

      // Control concurrency - wait if we've reached the limit
      if (executing.length >= concurrency) {
        await Promise.race(executing).then(() => {
          // Remove completed promises
          const index = executing.findIndex(p =>
            p === promise || (p as any).status === 'fulfilled' || (p as any).status === 'rejected'
          );
          if (index !== -1) {
            executing.splice(index, 1);
          }
        });
      }
    }

    // Wait for all remaining tests to complete
    await Promise.all(executing);

    return results;
  }

  /**
   * Test a single page on a specific device
   */
  private async testPage(pagePattern: string, device: string): Promise<VisualTestResult['results'][0]> {
    if (!this.browser) {
      throw new Error('Browser not initialized');
    }

    // Create context with device viewport
    const viewport = this.getDeviceViewport(device);
    const context = await this.browser.newContext({ viewport });
    const page = await context.newPage();

    // Set default baseline directory
    const baselineDir = '.iris/baselines';
    const storage = new StorageManager(baselineDir);

    try {
      // Navigate to page (assuming pagePattern is a URL for now)
      const url = pagePattern.startsWith('http') ? pagePattern : `http://localhost:3000${pagePattern}`;
      await page.goto(url, { waitUntil: 'networkidle' });

      // Wait for stabilization
      if (this.config.capture.stabilization.waitForFonts) {
        await page.evaluate(() => document.fonts.ready);
      }

      if (this.config.capture.stabilization.disableAnimations) {
        await page.addStyleTag({
          content: `
            *, *::before, *::after {
              animation-duration: 0s !important;
              animation-delay: 0s !important;
              transition-duration: 0s !important;
              transition-delay: 0s !important;
            }
          `
        });
      }

      if (this.config.capture.stabilization.delay > 0) {
        await page.waitForTimeout(this.config.capture.stabilization.delay);
      }

      if (this.config.capture.stabilization.waitForNetworkIdle) {
        await page.waitForLoadState('networkidle', {
          timeout: this.config.capture.stabilization.networkIdleTimeout
        });
      }

      // Capture screenshot
      const testName = `${pagePattern.replace(/\//g, '_')}_${device}`;
      const screenshotBuffer = await this.captureEngine.capture(page, {
        selector: undefined,
        fullPage: this.config.capture.fullPage,
        maskSelectors: this.config.capture.mask,
        stabilizeMs: 0, // Already stabilized above
        disableAnimations: false, // Already disabled above
        quality: this.config.capture.quality,
        type: this.config.capture.format
      });

      if (!screenshotBuffer.success || !screenshotBuffer.buffer) {
        throw new Error(`Failed to capture screenshot: ${screenshotBuffer.error}`);
      }

      // Save current screenshot
      const currentDir = await storage.ensureTestDirectory('current', testName);
      const screenshotPath = path.join(currentDir, `${testName}.png`);
      const fs = await import('fs');
      fs.writeFileSync(screenshotPath, screenshotBuffer.buffer);

      // Load baseline
      const baselineResult = await this.baselineManager.loadBaseline(testName);

      // If updating baselines or no baseline exists
      if (this.config.updateBaseline || !baselineResult.success) {
        await this.baselineManager.saveBaseline(
          testName,
          screenshotBuffer.buffer,
          screenshotBuffer.metadata
        );

        return {
          page: pagePattern,
          device,
          passed: true,
          similarity: 1.0,
          pixelDifference: 0,
          threshold: this.config.diff.threshold,
          screenshotPath,
          baselinePath: undefined
        };
      }

      // Compare with baseline
      const diffResult = await this.diffEngine.compare(
        baselineResult.buffer!,
        screenshotBuffer.buffer,
        {
          threshold: this.config.diff.threshold,
          includeAA: this.config.diff.antiAliasing,
          alpha: 0.1,
          diffMask: true,
          diffColor: [255, 0, 0]
        }
      );

      // Save diff image if there are differences
      let diffPath: string | undefined;
      if (!diffResult.passed && diffResult.diffBuffer) {
        const diffDir = await storage.ensureTestDirectory('diff', testName);
        diffPath = path.join(diffDir, `${testName}.png`);
        fs.writeFileSync(diffPath, diffResult.diffBuffer);
      }

      // Get baseline path for reporting
      const baselineDir = await storage.ensureTestDirectory('baseline', testName);
      const baselinePath = path.join(baselineDir, `${testName}.png`);
      fs.writeFileSync(baselinePath, baselineResult.buffer!);

      // AI classification if enabled and test failed
      let aiAnalysis: VisualTestResult['results'][0]['aiAnalysis'] | undefined;
      let severity: 'minor' | 'moderate' | 'breaking' | undefined;

      if (!diffResult.passed && this.aiClassifier && diffResult.diffBuffer) {
        const analysis = await this.aiClassifier.analyzeChange({
          baselineImage: baselineResult.buffer!,
          currentImage: screenshotBuffer.buffer,
          diffImage: diffResult.diffBuffer,
          context: {
            testName,
            url,
            viewport
          }
        });

        aiAnalysis = {
          classification: analysis.classification,
          confidence: analysis.confidence,
          description: analysis.description,
          severity: analysis.severity
        };

        // Map AI severity to test severity
        severity = this.mapAISeverity(analysis.severity);
      } else if (!diffResult.passed) {
        // Without AI, estimate severity based on pixel difference
        severity = this.estimateSeverity(diffResult.pixelDifference, diffResult.similarity);
      }

      return {
        page: pagePattern,
        device,
        passed: diffResult.passed,
        similarity: diffResult.similarity,
        pixelDifference: diffResult.pixelDifference,
        threshold: this.config.diff.threshold,
        severity,
        aiAnalysis,
        screenshotPath,
        baselinePath,
        diffPath
      };

    } finally {
      await context.close();
    }
  }

  /**
   * Get viewport dimensions for a device
   */
  private getDeviceViewport(device: string): { width: number; height: number } {
    const viewports: Record<string, { width: number; height: number }> = {
      desktop: { width: 1920, height: 1080 },
      laptop: { width: 1366, height: 768 },
      tablet: { width: 768, height: 1024 },
      mobile: { width: 375, height: 667 }
    };

    return viewports[device] || this.config.capture.viewport;
  }

  /**
   * Map AI severity to test severity levels
   */
  private mapAISeverity(aiSeverity: string): 'minor' | 'moderate' | 'breaking' {
    switch (aiSeverity.toLowerCase()) {
      case 'critical':
      case 'high':
        return 'breaking';
      case 'medium':
        return 'moderate';
      case 'low':
      default:
        return 'minor';
    }
  }

  /**
   * Estimate severity without AI based on metrics
   */
  private estimateSeverity(pixelDifference: number, similarity: number): 'minor' | 'moderate' | 'breaking' {
    // If similarity is very low or pixel difference is very high, it's breaking
    if (similarity < 0.85 || pixelDifference > 0.15) {
      return 'breaking';
    }

    // If similarity is somewhat low or pixel difference is moderate, it's moderate
    if (similarity < 0.95 || pixelDifference > 0.05) {
      return 'moderate';
    }

    // Otherwise it's minor
    return 'minor';
  }

  /**
   * Generate test report in the requested format
   */
  private async generateReport(
    results: VisualTestResult['results'],
    summary: VisualTestResult['summary']
  ): Promise<string> {
    const format = this.config.output?.format || 'json';
    const outputPath = this.config.output?.path || `./visual-report-${Date.now()}.${format}`;

    if (format === 'json') {
      const report = JSON.stringify({ summary, results }, null, 2);
      const fs = await import('fs');
      fs.writeFileSync(outputPath, report);
      return outputPath;
    }

    // HTML and JUnit formats to be implemented
    throw new Error(`Report format '${format}' not yet implemented`);
  }
}
