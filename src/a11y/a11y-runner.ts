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

import type { Browser, Page } from 'playwright';
import { launchBrowser, newHardenedContext } from '../browser';
import { AxeRunner } from './axe-integration';
import type { AxeConfig } from './axe-integration';
import { KeyboardTester } from './keyboard-tester';
import type { UrlPolicyOptions } from '../url-policy';
import { installUrlPolicyGuard, guardedGoto } from '../url-policy-guard';
import { escapeHtml, escapeXml, safeHref, stripUserinfo } from '../report-encoding';
import type { A11yResult, KeyboardTestResult, ScreenReaderTestResult } from './types';

export interface AccessibilityRunnerConfig {
  pages: string[];
  // Reuses AxeConfig rather than restating its shape — the two drifted apart and
  // silently dropped `runOnlyRules` on the way through (issue #72).
  axe: AxeConfig;
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
  output?: {
    format: 'html' | 'json' | 'junit';
    path?: string;
  };
  /** Origin for relative `pages` patterns. Defaults to `http://localhost:3000` when unset. */
  baseURL?: string;
  /**
   * When set, enforce the navigation URL policy on every request the page makes,
   * not just the initial URL — so a scanned page cannot pull a sub-resource from
   * a metadata/link-local host. Same mechanism as `Executor.createPage`.
   *
   * Covers sub-resources and redirect chains alike — Playwright does not re-route
   * the target of a 30x, so those hops are vetted explicitly. See
   * `src/url-policy-guard.ts` and issue #148.
   *
   * Always enforced (#335). Unset means the operator default: `file:` and `data:`
   * allowed, as the `iris a11y` CLI's typed URLs need, metadata hosts refused.
   * IRIS_HOSTED overrides either way. The MCP tool passes `{}`, since its URLs
   * are model-supplied and may be derived from untrusted page content.
   */
  urlPolicy?: UrlPolicyOptions;
  /**
   * Fail a page whose final navigation answers HTTP 400 or above, instead of scanning
   * the error page (hosted jobs: the egress proxy refuses a plain-HTTP request to an
   * internal address with a 403, which is a document to the browser and would be
   * scanned, recorded and billed as a success).
   */
  failOnHttpError?: boolean;
  /**
   * Stop at the first page that fails instead of scanning the rest (#287). The hosted
   * worker sets it: its job fails as a whole anyway, so the other pages would be browser
   * time spent on results that are thrown away.
   */
  failFast?: boolean;
}

export interface AccessibilityTestResult {
  summary: {
    totalViolations: number;
    /** 0-100 over the pages that were scanned; null when none could be (#287). */
    score: number | null;
    /**
     * Whether the pages that WERE scanned meet the failure threshold (#287). `passed` is
     * false when any page errored too; this tells a violation from an unscanned page.
     */
    scannedPassed: boolean;
    passed: boolean;
    violationsBySeverity: {
      critical: number;
      serious: number;
      moderate: number;
      minor: number;
    };
    pagesTested: number;
    /** Pages that could not be scanned (navigation, timeout): failures, not passes (#287). */
    pagesErrored: number;
    keyboardTestsPassed: number;
    keyboardTestsFailed: number;
  };
  results: Array<{
    page: string;
    axeResult: A11yResult;
    keyboardResult?: KeyboardTestResult;
    screenReaderResult?: ScreenReaderTestResult;
    /** Why this page could not be scanned; its axe result is then empty (#287). */
    error?: string;
    /**
     * This page's verdict: the one the exit code, both reports and history read (#288).
     * False for an error, axe violations at the failure threshold, or a failed keyboard or
     * screen-reader check; `failureReasons` says which.
     */
    passed: boolean;
    failureReasons: string[];
  }>;
  reportPath?: string;
  duration: number;
}

/**
 * AccessibilityRunner orchestrates comprehensive accessibility testing
 */
/** A page that could not be scanned: its reason, and an empty axe result (#287). */
function erroredPage(page: string, error: unknown): AccessibilityTestResult['results'][0] {
  const empty = { total: 0, violations: 0, passes: 0, incomplete: 0, inapplicable: 0 };
  return {
    page,
    // Stripped here, once: the CLI prints it and every report and store carries it.
    // Never empty: an empty reason must not read as no error anywhere it is shown.
    error:
      stripUserinfo(error instanceof Error ? error.message : String(error ?? '')) ||
      'Unknown error',
    passed: false,
    failureReasons: ['could not be scanned'],
    axeResult: {
      testName: page,
      url: page,
      timestamp: new Date(),
      passed: false,
      violations: [],
      passes: [],
      incomplete: [],
      inapplicable: [],
      summary: empty,
      testRunner: { name: 'axe-core', version: '' },
    },
  };
}

/**
 * Weighted accessibility score (0-100) for a set of violation counts.
 *
 * Module-level so run history can score each page on its own violations with
 * the same weights the runner uses for its summary, rather than duplicating
 * the penalties or storing the run-wide score against every page (issue #77).
 */
export function calculateAccessibilityScore(
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
      this.browser = await launchBrowser();

      // Test each page
      for (const pagePattern of this.config.pages) {
        // One page that fails (navigation, timeout, a check that throws on hostile markup)
        // is that page's errored result; the others still run (#287). Hosted jobs, which
        // fail as a whole, turn it back into a throw in the worker.
        const result = await this.testPage(pagePattern).catch((error: unknown) =>
          erroredPage(pagePattern, error),
        );
        results.push(result);
        if (result.error !== undefined && this.config.failFast) break;

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
      // Over scanned pages only: an unscanned page has no violations, and counting it would
      // raise the score (one failing page and one unreachable one scored 88, not 75).
      const scanned = results.filter((r) => r.error === undefined);
      const score =
        scanned.length > 0
          ? this.calculateAccessibilityScore(violationsBySeverity, scanned.length)
          : null;
      const scannedPassed = this.checkOverallPass(scanned);
      const passed = scannedPassed && scanned.length === results.length;

      // Count keyboard test results
      const keyboardResults = results.filter((r) => r.keyboardResult);
      const keyboardTestsPassed = keyboardResults.filter((r) => r.keyboardResult?.passed).length;
      const keyboardTestsFailed = keyboardResults.length - keyboardTestsPassed;

      const summary = {
        totalViolations,
        score,
        passed,
        scannedPassed,
        violationsBySeverity,
        pagesTested: results.length,
        pagesErrored: results.filter((r) => r.error !== undefined).length,
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

    const context = await newHardenedContext(this.browser);
    const page = await context.newPage();

    try {
      // Install before the first navigation so no request escapes the guard.
      await installUrlPolicyGuard(
        page,
        this.config.urlPolicy ?? { allowFile: true, allowData: true },
      );

      // Navigate to page. Treat any scheme-prefixed value (http:, https:, about:,
      // data:, file:) as a complete URL; only bare paths get the dev-server base.
      const isFullUrl = /^[a-z]+:/i.test(pagePattern);
      // Trim a trailing slash off the base so `https://host/` + `/about` doesn't double up.
      const base = (this.config.baseURL ?? 'http://localhost:3000').replace(/\/$/, '');
      const url = isFullUrl ? pagePattern : `${base}${pagePattern}`;
      // guardedGoto walks any redirect chain one vetted hop at a time, as real
      // navigations, so the scanned document's URL and asset base stay correct.
      //
      // Report where it LANDED, not where it was pointed: a scan of `http://host/`
      // that redirects to `/login` measured `/login`, and labelling that result
      // with the original URL would misattribute every violation on it.
      let status = 0;
      if (this.config.failOnHttpError) {
        page.on('response', (r) => {
          if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) {
            status = r.status();
          }
        });
      }
      const scannedUrl = await guardedGoto(page, url, { waitUntil: 'networkidle' });
      if (this.config.failOnHttpError && status >= 400) {
        throw new Error(`${pagePattern} answered HTTP ${status}`);
      }

      const testName = pagePattern.replace(/\//g, '_') || 'index';

      // Run axe-core tests
      const axeResult = await this.axeRunner.run(page, testName, scannedUrl);

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

      return this.withVerdict({
        page: pagePattern,
        axeResult,
        keyboardResult,
        screenReaderResult,
      });
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
      // Test ARIA labels. Each announcement is validated rather than assumed
      // good: an empty aria-label or a labelledby pointing at a missing/blank
      // element renders the accessible name useless, and previously every one of
      // these was recorded as success: true and excluded from the verdict.
      if (this.config.screenReader.testAriaLabels) {
        const ariaElements = await page.evaluate(() => {
          const elements = document.querySelectorAll(
            '[aria-label], [aria-labelledby], [aria-describedby]',
          );

          return Array.from(elements).map((el) => {
            const label = el.getAttribute('aria-label');
            const labelledBy = el.getAttribute('aria-labelledby');
            const describedBy = el.getAttribute('aria-describedby');
            const problems: string[] = [];

            // Present-but-blank is worse than absent: it suppresses the fallback
            // accessible name a screen reader would otherwise compute.
            if (label !== null && label.trim() === '') {
              problems.push('aria-label is empty');
            }

            const checkRefs = (attr: string, value: string, requireText: boolean) => {
              const ids = value.split(/\s+/).filter(Boolean);
              if (ids.length === 0) {
                // Only a missing NAME is a defect. aria-describedby supplements
                // the accessible name rather than providing it, so an empty one
                // is untidy, not broken.
                if (requireText) problems.push(`${attr} is empty`);
                return;
              }
              for (const id of ids) {
                const target = document.getElementById(id);
                if (!target) {
                  problems.push(`${attr} references missing id "${id}"`);
                } else if (requireText && !(target.textContent || '').trim()) {
                  problems.push(`${attr} target "${id}" has no text`);
                }
              }
            };

            if (labelledBy !== null) checkRefs('aria-labelledby', labelledBy, true);
            if (describedBy !== null) checkRefs('aria-describedby', describedBy, false);

            const resolvedLabel =
              label?.trim() ||
              (labelledBy || '')
                .split(/\s+/)
                .filter(Boolean)
                .map((id) => document.getElementById(id)?.textContent?.trim() || '')
                .filter(Boolean)
                .join(' ');

            return {
              element: el.tagName + (el.id ? `#${el.id}` : ''),
              expectedText: label || '',
              actualText: problems.length > 0 ? problems.join('; ') : resolvedLabel,
              role: el.getAttribute('role') || '',
              properties: {
                'aria-label': label || '',
                'aria-labelledby': labelledBy || '',
                'aria-describedby': describedBy || '',
              },
              success: problems.length === 0,
            };
          });
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

      // Announcements now count toward the verdict. They were collected, always
      // marked successful, and then ignored — so a broken accessible name could
      // never fail a run (issue #73).
      const announcementsValid = announcements.every((a) => a.success);

      return {
        testName,
        passed: headingHierarchyValid && landmarkValid && imageAltValid && announcementsValid,
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
    return calculateAccessibilityScore(violations, pageCount);
  }

  /**
   * Check if overall test passed based on failure threshold
   */
  private checkOverallPass(results: AccessibilityTestResult['results']): boolean {
    return results.every((result) => result.passed);
  }

  /** The axe violations of a page that meet the failure threshold (`--fail-on`). */
  private violationsAtThreshold(result: AccessibilityTestResult['results'][0]) {
    return result.axeResult.violations.filter(
      (v) => this.config.failureThreshold?.[v.impact || 'moderate'] === true,
    );
  }

  /**
   * The one per-page verdict (#288): exit code, HTML, JUnit and history all read it. They
   * used to decide on their own: the reports from axe alone (keyboard and screen-reader
   * failures dropped, JUnit failing every violation whatever `--fail-on` said) and
   * history from "any violation".
   */
  private withVerdict(
    result: Omit<AccessibilityTestResult['results'][0], 'passed' | 'failureReasons'>,
  ): AccessibilityTestResult['results'][0] {
    const failureReasons: string[] = [];
    const page = { ...result, passed: true, failureReasons };
    const breaching = this.violationsAtThreshold(page).length;
    if (breaching > 0)
      failureReasons.push(`axe: ${breaching} violation(s) at the failure threshold`);
    if (result.keyboardResult && !result.keyboardResult.passed) {
      const failed = result.keyboardResult.interactions.filter((i) => !i.success).length;
      failureReasons.push(`keyboard: ${failed || 'some'} check(s) failed`);
    }
    if (result.screenReaderResult && !result.screenReaderResult.passed) {
      failureReasons.push('screen reader: checks failed');
    }
    page.passed = failureReasons.length === 0;
    return page;
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
      report = this.generateJUnitReport(results);
    } else {
      throw new Error(`Report format '${format}' not yet implemented`);
    }

    const fs = await import('fs');
    const path = await import('path');
    // After a long scan, a missing directory must not lose the results (#287).
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    fs.writeFileSync(outputPath, report);
    return outputPath;
  }

  /**
   * Generate a self-contained HTML accessibility report.
   */
  private generateHtmlReport(
    results: AccessibilityTestResult['results'],
    summary: AccessibilityTestResult['summary'],
  ): string {
    const esc = escapeHtml;
    const pages = results
      .map((r) => {
        const violations = r.axeResult.violations
          .map(
            (v) => `
        <div class="violation ${esc(v.impact)}">
          <h4>${esc(v.id)} <span class="impact">${esc(v.impact)}</span></h4>
          <p>${esc(v.description)}</p>
          <p>${helpLink(v.help, v.helpUrl)}</p>
          <ul>${v.nodes
            .map((n) => `<li><code>${esc(n.html)}</code> — ${esc(n.target.join(', '))}</li>`)
            .join('')}</ul>
        </div>`,
          )
          .join('');
        // A page that could not be scanned found nothing, which is not "no violations".
        const body =
          r.error !== undefined
            ? `<p class="error">Could not be scanned: ${esc(r.error)}</p>`
            : r.axeResult.violations.length === 0
              ? '<p class="ok">No violations found.</p>'
              : violations;
        // The page's verdict, the one the CLI exits on (#288), and why.
        const verdict = r.passed ? 'PASSED' : 'FAILED';
        const reasons = r.failureReasons.length
          ? `<ul class="reasons">${r.failureReasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`
          : '';
        return `
      <section class="page ${r.passed ? 'passed' : 'failed'}">
        <h3>${esc(r.page)} <small>${esc(r.axeResult.url)}</small>
          <span class="verdict">${verdict}</span></h3>
        ${reasons}
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
    .error { color: #991b1b; }
    .verdict { font-size: 0.75rem; padding: 2px 6px; border-radius: 4px; margin-left: 0.5rem; }
    .passed .verdict { background: #dcfce7; color: #166534; }
    .failed .verdict { background: #fee2e2; color: #991b1b; }
    code { background: #f0f0f0; padding: 2px 4px; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>Accessibility Report</h1>
  <div class="summary">
    <div><strong>${summary.score === null ? '—' : `${summary.score}/100`}</strong><br>Score</div>
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
  private generateJUnitReport(results: AccessibilityTestResult['results']): string {
    const esc = escapeXml;
    // Per page, one testcase per check that ran, failing exactly as the page's verdict
    // does (#288): axe fails only on violations at the threshold (the rest are listed as
    // output), and keyboard and screen-reader checks are cases of their own.
    const suites = results.map((r) => {
      if (r.error !== undefined) {
        // JUnit's <error>: the test could not run, which a CI reader must not read as a pass.
        return {
          tests: 1,
          failures: 0,
          errors: 1,
          xml: `  <testsuite name="${esc(r.page)}" tests="1" failures="0" errors="1">
    <testcase name="${esc(r.page)} accessibility" classname="a11y">
      <error message="${esc(r.error)}" type="PageError"/>
    </testcase>
  </testsuite>`,
        };
      }
      const describe = (v: AccessibilityTestResult['results'][0]['axeResult']['violations'][0]) =>
        `${v.id} [${v.impact}]: ${v.help}\n${v.helpUrl}\n${v.nodes
          .map((n) => `${n.target.join(', ')}: ${n.html}`)
          .join('\n')}`;
      const breaching = this.violationsAtThreshold(r);
      const below = r.axeResult.violations.filter((v) => !breaching.includes(v));
      const cases: Array<{ name: string; failure?: string; detail?: string; out?: string }> = [
        {
          name: 'axe',
          ...(breaching.length > 0 && {
            failure: `${breaching.length} violation(s) at the failure threshold`,
            detail: breaching.map(describe).join('\n\n'),
          }),
          ...(below.length > 0 && {
            out: `Below the failure threshold:\n${below.map(describe).join('\n\n')}`,
          }),
        },
      ];
      if (r.keyboardResult) {
        const failed = r.keyboardResult.interactions.filter((i) => !i.success);
        cases.push({
          name: 'keyboard',
          ...(!r.keyboardResult.passed && {
            failure: 'keyboard checks failed',
            detail: failed.map((i) => `${i.key} on ${i.target}: ${i.actualBehavior}`).join('\n'),
          }),
        });
      }
      if (r.screenReaderResult) {
        cases.push({
          name: 'screen reader',
          ...(!r.screenReaderResult.passed && { failure: 'screen-reader checks failed' }),
        });
      }
      const failures = cases.filter((c) => c.failure).length;
      const body = cases
        .map(
          (c) => `    <testcase name="${esc(c.name)}" classname="${esc(r.page)}">${
            c.failure
              ? `
      <failure message="${esc(c.failure)}" type="${esc(c.name)}">${esc(c.detail ?? '')}</failure>`
              : ''
          }${
            c.out
              ? `
      <system-out>${esc(c.out)}</system-out>`
              : ''
          }
    </testcase>`,
        )
        .join('\n');
      return {
        tests: cases.length,
        failures,
        errors: 0,
        xml: `  <testsuite name="${esc(r.page)}" tests="${cases.length}" failures="${failures}">
${body}
  </testsuite>`,
      };
    });
    const total = (key: 'tests' | 'failures' | 'errors') =>
      suites.reduce((sum, suite) => sum + suite[key], 0);

    return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="iris-a11y" tests="${total('tests')}" failures="${total('failures')}" errors="${total('errors')}">
${suites.map((suite) => suite.xml).join('\n')}
</testsuites>`;
  }
}

/**
 * The rule's help text, linked to its help page only over http(s). axe runs
 * inside the page under test, so a hostile page controls `helpUrl`; escaping keeps
 * a `javascript:` URL inside its quotes but would still leave it clickable.
 */
function helpLink(help: string, helpUrl: string): string {
  const href = safeHref(helpUrl);
  return href
    ? `<a href="${escapeHtml(href)}">${escapeHtml(help)}</a>`
    : `${escapeHtml(help)} (${escapeHtml(helpUrl)})`;
}
