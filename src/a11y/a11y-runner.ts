/**
 * AccessibilityRunner - Orchestrates comprehensive accessibility testing
 *
 * This module provides high-level orchestration for running accessibility tests,
 * coordinating between axe-core, keyboard navigation, and screen reader simulation.
 *
 * NOTE: The page.evaluate() callbacks below are serialized and executed in the
 * browser's V8 context, not Node. Jest/Istanbul coverage instrumentation injects
 * cov_* counters that are undefined in the browser, so this module is excluded
 * from coverage instrumentation (see jest.config.ts). It is covered by the a11y
 * e2e suite, not Istanbul.
 */

import { chromium, Browser, Page } from 'playwright';
import { AxeRunner } from './axe-integration';
import { KeyboardTester } from './keyboard-tester';
import type { A11yResult, KeyboardTestResult, ScreenReaderTestResult } from './types';

export interface AccessibilityRunnerConfig {
  pages: string[];
  axe: {
    rules: Record<string, { enabled: boolean }>;
    tags: string[];
    include: string[];
    exclude: string[];
    disableRules: string[];
    timeout: number;
  };
  keyboard: {
    testFocusOrder: boolean;
    testTrapDetection: boolean;
    testArrowKeyNavigation: boolean;
    testEscapeHandling: boolean;
    customSequences: Array<{
      name: string;
      keys: string[];
      expectedBehavior: string;
      validator?: string;
    }>;
  };
  screenReader: {
    testAriaLabels: boolean;
    testLandmarkNavigation: boolean;
    testImageAltText: boolean;
    testHeadingStructure: boolean;
    simulateScreenReader: boolean;
  };
  failureThreshold: Record<string, boolean>; // { critical: true, serious: true, ... }
  reporting: {
    includePassedTests: boolean;
    groupByImpact: boolean;
    includeScreenshots: boolean;
  };
  output?: {
    format: 'html' | 'json' | 'junit';
    path?: string;
  };
  /** Origin for relative `pages` patterns. Defaults to `http://localhost:3000` when unset. */
  baseURL?: string;
}

export interface AccessibilityTestResult {
  summary: {
    totalViolations: number;
    score: number; // 0-100 accessibility score
    passed: boolean;
    violationsBySeverity: {
      critical: number;
      serious: number;
      moderate: number;
      minor: number;
    };
    pagesTested: number;
    keyboardTestsPassed: number;
    keyboardTestsFailed: number;
  };
  results: Array<{
    page: string;
    axeResult: A11yResult;
    keyboardResult?: KeyboardTestResult;
    screenReaderResult?: ScreenReaderTestResult;
  }>;
  reportPath?: string;
  duration: number;
}

/**
 * AccessibilityRunner orchestrates comprehensive accessibility testing
 */
export class AccessibilityRunner {
  private config: AccessibilityRunnerConfig;
  private axeRunner: AxeRunner;
  private keyboardTester: KeyboardTester;
  private browser?: Browser;

  constructor(config: AccessibilityRunnerConfig) {
    this.config = config;

    // Initialize test runners
    this.axeRunner = new AxeRunner(config.axe);
    this.keyboardTester = new KeyboardTester(config.keyboard);
  }

  /**
   * Run comprehensive accessibility tests for all configured pages
   */
  async run(): Promise<AccessibilityTestResult> {
    const startTime = Date.now();
    const results: AccessibilityTestResult['results'] = [];
    const violationsBySeverity = {
      critical: 0,
      serious: 0,
      moderate: 0,
      minor: 0,
    };

    try {
      // Launch browser
      this.browser = await chromium.launch({
        headless: true,
      });

      // Test each page
      for (const pagePattern of this.config.pages) {
        const result = await this.testPage(pagePattern);
        results.push(result);

        // Aggregate severity counts
        const severityCounts = this.axeRunner.getSeverityCounts(result.axeResult);
        violationsBySeverity.critical += severityCounts.critical || 0;
        violationsBySeverity.serious += severityCounts.serious || 0;
        violationsBySeverity.moderate += severityCounts.moderate || 0;
        violationsBySeverity.minor += severityCounts.minor || 0;
      }

      // Calculate overall metrics
      const totalViolations = Object.values(violationsBySeverity).reduce(
        (sum, count) => sum + count,
        0,
      );
      const score = this.calculateAccessibilityScore(violationsBySeverity, results.length);
      const passed = this.checkOverallPass(results);

      // Count keyboard test results
      const keyboardResults = results.filter((r) => r.keyboardResult);
      const keyboardTestsPassed = keyboardResults.filter((r) => r.keyboardResult?.passed).length;
      const keyboardTestsFailed = keyboardResults.length - keyboardTestsPassed;

      const summary = {
        totalViolations,
        score,
        passed,
        violationsBySeverity,
        pagesTested: results.length,
        keyboardTestsPassed,
        keyboardTestsFailed,
      };

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
        duration,
      };
    } finally {
      // Cleanup browser
      if (this.browser) {
        await this.browser.close();
      }
    }
  }

  /**
   * Test a single page for accessibility issues
   */
  private async testPage(pagePattern: string): Promise<AccessibilityTestResult['results'][0]> {
    if (!this.browser) {
      throw new Error('Browser not initialized');
    }

    const context = await this.browser.newContext();
    const page = await context.newPage();

    try {
      // Navigate to page. Treat any scheme-prefixed value (http:, https:, about:,
      // data:, file:) as a complete URL; only bare paths get the dev-server base.
      const isFullUrl = /^[a-z]+:/i.test(pagePattern);
      // Trim a trailing slash off the base so `https://host/` + `/about` doesn't double up.
      const base = (this.config.baseURL ?? 'http://localhost:3000').replace(/\/$/, '');
      const url = isFullUrl ? pagePattern : `${base}${pagePattern}`;
      await page.goto(url, { waitUntil: 'networkidle' });

      const testName = pagePattern.replace(/\//g, '_') || 'index';

      // Run axe-core tests
      const axeResult = await this.axeRunner.run(page, testName, url);

      // Run keyboard navigation tests if enabled
      let keyboardResult: KeyboardTestResult | undefined;
      if (this.shouldRunKeyboardTests()) {
        keyboardResult = await this.keyboardTester.run(page, testName);
      }

      // Run screen reader simulation if enabled
      let screenReaderResult: ScreenReaderTestResult | undefined;
      if (this.shouldRunScreenReaderTests()) {
        screenReaderResult = await this.runScreenReaderTests(page, testName);
      }

      return {
        page: pagePattern,
        axeResult,
        keyboardResult,
        screenReaderResult,
      };
    } finally {
      await context.close();
    }
  }

  /**
   * Check if keyboard tests should run
   */
  private shouldRunKeyboardTests(): boolean {
    return (
      this.config.keyboard.testFocusOrder ||
      this.config.keyboard.testTrapDetection ||
      this.config.keyboard.testArrowKeyNavigation ||
      this.config.keyboard.testEscapeHandling ||
      this.config.keyboard.customSequences.length > 0
    );
  }

  /**
   * Check if screen reader tests should run
   */
  private shouldRunScreenReaderTests(): boolean {
    return (
      this.config.screenReader.testAriaLabels ||
      this.config.screenReader.testLandmarkNavigation ||
      this.config.screenReader.testImageAltText ||
      this.config.screenReader.testHeadingStructure ||
      this.config.screenReader.simulateScreenReader
    );
  }

  /**
   * Run screen reader simulation tests
   * Note: This is a basic implementation - full screen reader simulation requires more sophisticated tooling
   */
  private async runScreenReaderTests(
    page: Page,
    testName: string,
  ): Promise<ScreenReaderTestResult> {
    const announcements: ScreenReaderTestResult['announcements'] = [];
    const landmarkStructure: ScreenReaderTestResult['landmarkStructure'] = [];
    const headingStructure: ScreenReaderTestResult['headingStructure'] = [];
    const imageAltResults: NonNullable<ScreenReaderTestResult['imageAltResults']> = [];

    try {
      // Test ARIA labels
      if (this.config.screenReader.testAriaLabels) {
        const ariaElements = await page.evaluate(() => {
          const elements = document.querySelectorAll(
            '[aria-label], [aria-labelledby], [aria-describedby]',
          );
          return Array.from(elements).map((el) => ({
            element: el.tagName + (el.id ? `#${el.id}` : ''),
            expectedText: el.getAttribute('aria-label') || '',
            actualText: el.getAttribute('aria-label') || el.textContent?.trim() || '',
            role: el.getAttribute('role') || '',
            properties: {
              'aria-label': el.getAttribute('aria-label') || '',
              'aria-labelledby': el.getAttribute('aria-labelledby') || '',
              'aria-describedby': el.getAttribute('aria-describedby') || '',
            },
            success: true,
          }));
        });
        announcements.push(...ariaElements);
      }

      // Test landmark structure
      if (this.config.screenReader.testLandmarkNavigation) {
        const landmarks = await page.evaluate(() => {
          const landmarkElements = document.querySelectorAll(
            '[role="banner"], [role="navigation"], [role="main"], [role="complementary"], [role="contentinfo"], header, nav, main, aside, footer',
          );
          return Array.from(landmarkElements).map((el) => ({
            type: el.getAttribute('role') || el.tagName.toLowerCase(),
            label: el.getAttribute('aria-label') || undefined,
            element: el.tagName + (el.id ? `#${el.id}` : ''),
            level: undefined,
          }));
        });
        landmarkStructure.push(...landmarks);
      }

      // Test heading structure
      if (this.config.screenReader.testHeadingStructure) {
        const headings = await page.evaluate(() => {
          const headingElements = document.querySelectorAll(
            'h1, h2, h3, h4, h5, h6, [role="heading"]',
          );
          return Array.from(headingElements).map((el) => {
            const level = el.tagName.match(/h(\d)/i)?.[1] || el.getAttribute('aria-level');
            return {
              level: parseInt(level || '1'),
              text: el.textContent?.trim() || '',
              element: el.tagName + (el.id ? `#${el.id}` : ''),
            };
          });
        });
        headingStructure.push(...headings);
      }

      // Test image alt text. Missing `alt` is a violation; empty alt,
      // role="presentation", or aria-hidden marks a valid decorative image;
      // a non-empty alt is a valid meaningful image.
      if (this.config.screenReader.testImageAltText) {
        const images = await page.evaluate(() => {
          const imageElements = document.querySelectorAll('img, [role="img"]');
          return Array.from(imageElements).map((el) => {
            const hasAlt = el.hasAttribute('alt');
            const alt = el.getAttribute('alt') ?? undefined;
            const isDecorative =
              alt === '' ||
              el.getAttribute('role') === 'presentation' ||
              el.getAttribute('aria-hidden') === 'true';
            return {
              element: el.tagName + (el.id ? `#${el.id}` : ''),
              alt,
              hasAlt,
              isDecorative,
              // Valid when decorative, or when a meaningful (non-empty) alt is present.
              success: isDecorative || (hasAlt && (alt ?? '').length > 0),
            };
          });
        });
        imageAltResults.push(...images);
      }

      // Validate heading hierarchy
      const headingHierarchyValid = this.validateHeadingHierarchy(headingStructure);

      // Only factor landmarks into the verdict when landmark testing was
      // requested — otherwise a heading-only run can never pass.
      const landmarkValid =
        !this.config.screenReader.testLandmarkNavigation || landmarkStructure.length > 0;

      // Image alt is valid when the check was disabled or no image failed.
      const imageAltValid = imageAltResults.every((img) => img.success);

      return {
        testName,
        passed: headingHierarchyValid && landmarkValid && imageAltValid,
        announcements,
        landmarkStructure,
        headingStructure,
        imageAltResults,
      };
    } catch (error) {
      throw new Error(
        `Screen reader testing failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Validate heading hierarchy (no skipped levels)
   */
  private validateHeadingHierarchy(headings: ScreenReaderTestResult['headingStructure']): boolean {
    if (headings.length === 0) return true;

    let previousLevel = 0;
    for (const heading of headings) {
      // Check if we skipped a level (e.g., h1 -> h3)
      if (heading.level - previousLevel > 1) {
        return false;
      }
      previousLevel = heading.level;
    }
    return true;
  }

  /**
   * Calculate accessibility score (0-100)
   */
  private calculateAccessibilityScore(
    violations: { critical: number; serious: number; moderate: number; minor: number },
    pageCount: number,
  ): number {
    // Weighted scoring: critical issues heavily penalized
    const criticalPenalty = violations.critical * 25;
    const seriousPenalty = violations.serious * 10;
    const moderatePenalty = violations.moderate * 5;
    const minorPenalty = violations.minor * 2;

    const totalPenalty = criticalPenalty + seriousPenalty + moderatePenalty + minorPenalty;
    const maxPossibleScore = 100 * pageCount;

    const score = (Math.max(0, maxPossibleScore - totalPenalty) / maxPossibleScore) * 100;

    return Math.round(score);
  }

  /**
   * Check if overall test passed based on failure threshold
   */
  private checkOverallPass(results: AccessibilityTestResult['results']): boolean {
    for (const result of results) {
      // Check axe results against threshold
      if (!this.axeRunner.checkThreshold(result.axeResult, this.config.failureThreshold)) {
        return false;
      }

      // Check keyboard results
      if (result.keyboardResult && !result.keyboardResult.passed) {
        return false;
      }

      // Check screen reader results
      if (result.screenReaderResult && !result.screenReaderResult.passed) {
        return false;
      }
    }

    return true;
  }

  /**
   * Generate accessibility report
   */
  private async generateReport(
    results: AccessibilityTestResult['results'],
    summary: AccessibilityTestResult['summary'],
  ): Promise<string> {
    const format = this.config.output?.format || 'json';
    const outputPath = this.config.output?.path || `./a11y-report-${Date.now()}.${format}`;

    let report: string;
    if (format === 'json') {
      report = JSON.stringify({ summary, results }, null, 2);
    } else if (format === 'html') {
      report = this.generateHtmlReport(results, summary);
    } else if (format === 'junit') {
      report = this.generateJUnitReport(results, summary);
    } else {
      throw new Error(`Report format '${format}' not yet implemented`);
    }

    const fs = await import('fs');
    fs.writeFileSync(outputPath, report);
    return outputPath;
  }

  /**
   * Escape a string for safe inclusion in HTML/XML text and attributes.
   */
  private escape(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Generate a self-contained HTML accessibility report.
   */
  private generateHtmlReport(
    results: AccessibilityTestResult['results'],
    summary: AccessibilityTestResult['summary'],
  ): string {
    const esc = (v: string) => this.escape(v);
    const pages = results
      .map((r) => {
        const violations = r.axeResult.violations
          .map(
            (v) => `
        <div class="violation ${esc(v.impact)}">
          <h4>${esc(v.id)} <span class="impact">${esc(v.impact)}</span></h4>
          <p>${esc(v.description)}</p>
          <p><a href="${esc(v.helpUrl)}">${esc(v.help)}</a></p>
          <ul>${v.nodes
            .map((n) => `<li><code>${esc(n.html)}</code> — ${esc(n.target.join(', '))}</li>`)
            .join('')}</ul>
        </div>`,
          )
          .join('');
        const body =
          r.axeResult.violations.length === 0
            ? '<p class="ok">No violations found.</p>'
            : violations;
        return `
      <section class="page">
        <h3>${esc(r.page)} <small>${esc(r.axeResult.url)}</small></h3>
        ${body}
      </section>`;
      })
      .join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Accessibility Report</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; color: #1a1a1a; }
    .summary { display: flex; gap: 1.5rem; flex-wrap: wrap; margin-bottom: 2rem; }
    .summary div { padding: 1rem; border: 1px solid #ddd; border-radius: 8px; }
    .violation { border-left: 4px solid #999; padding: 0.5rem 1rem; margin: 1rem 0; background: #fafafa; }
    .violation.critical { border-color: #d73a4a; }
    .violation.serious { border-color: #e36209; }
    .violation.moderate { border-color: #dbab09; }
    .violation.minor { border-color: #0366d6; }
    .impact { font-size: 0.75rem; text-transform: uppercase; background: #eee; padding: 2px 6px; border-radius: 4px; }
    .ok { color: #22863a; }
    code { background: #f0f0f0; padding: 2px 4px; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>Accessibility Report</h1>
  <div class="summary">
    <div><strong>${summary.score}/100</strong><br>Score</div>
    <div><strong>${summary.passed ? 'PASS' : 'FAIL'}</strong><br>Result</div>
    <div><strong>${summary.totalViolations}</strong><br>Violations</div>
    <div><strong>${summary.pagesTested}</strong><br>Pages</div>
    <div>Critical ${summary.violationsBySeverity.critical} · Serious ${summary.violationsBySeverity.serious} · Moderate ${summary.violationsBySeverity.moderate} · Minor ${summary.violationsBySeverity.minor}</div>
  </div>
  ${pages}
</body>
</html>`;
  }

  /**
   * Generate a JUnit XML report (one testsuite per page, one testcase per axe rule violation).
   */
  private generateJUnitReport(
    results: AccessibilityTestResult['results'],
    summary: AccessibilityTestResult['summary'],
  ): string {
    const esc = (v: string) => this.escape(v);
    // One testcase per violation, or a single passing testcase when a page is clean.
    const totalTests = results.reduce(
      (sum, r) => sum + Math.max(r.axeResult.violations.length, 1),
      0,
    );
    const suites = results
      .map((r) => {
        const violations = r.axeResult.violations;
        const cases =
          violations.length === 0
            ? `    <testcase name="${esc(r.page)} accessibility" classname="a11y"/>`
            : violations
                .map((v) => {
                  const detail = `${v.description}\n${v.help}\n${v.helpUrl}\n${v.nodes
                    .map((n) => `${n.target.join(', ')}: ${n.html}`)
                    .join('\n')}`;
                  return `    <testcase name="${esc(v.id)}" classname="${esc(r.page)}">
      <failure message="${esc(v.help)}" type="${esc(v.impact)}">${esc(detail)}</failure>
    </testcase>`;
                })
                .join('\n');
        return `  <testsuite name="${esc(r.page)}" tests="${Math.max(
          violations.length,
          1,
        )}" failures="${violations.length}">
${cases}
  </testsuite>`;
      })
      .join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="iris-a11y" tests="${totalTests}" failures="${summary.totalViolations}">
${suites}
</testsuites>`;
  }
}
