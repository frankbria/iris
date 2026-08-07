/**
 * Axe-core Integration Module
 *
 * Provides integration with axe-core for WCAG 2.1 compliance testing
 */

import { Page } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import type { A11yResult, A11yViolation } from './types';

export interface AxeConfig {
  /** Per-rule enable/disable, merged with `disableRules` into one axe `rules` map. */
  rules: Record<string, { enabled: boolean }>;
  /** WCAG tag filter. Ignored when `runOnlyRules` is set — axe allows one runOnly. */
  tags: string[];
  /** Run ONLY these rules (CLI `--rules`). Takes precedence over `tags`. */
  runOnlyRules?: string[];
  include: string[];
  exclude: string[];
  disableRules: string[];
  /** Upper bound in ms on a single axe analysis; a hung scan fails instead of stalling. */
  timeout: number;
}

/**
 * AxeRunner handles axe-core execution and result processing
 */
export class AxeRunner {
  private config: AxeConfig;

  constructor(config: AxeConfig) {
    this.config = config;
  }

  /**
   * Build a configured AxeBuilder from this runner's config.
   *
   * Call order is load-bearing. AxeBuilder.options() assigns `this.option`
   * wholesale, so it must run BEFORE withTags/withRules — those merge into
   * `this.option.runOnly`, and doing it the other way round silently erases the
   * runOnly filter and quietly widens the scan back to everything.
   *
   * disableRules() is deliberately not used: it assigns `this.option.rules = {}`
   * before filling, which would discard `config.rules`. The two rule sources are
   * merged here instead and issued as one options() call.
   *
   * @param forcedInclude Restrict to a single selector (used by runOnElement),
   *                      overriding `config.include`.
   */
  private buildAxe(page: Page, forcedInclude?: string): AxeBuilder {
    let axeBuilder = new AxeBuilder({ page });

    const rules: Record<string, { enabled: boolean }> = { ...this.config.rules };
    for (const ruleId of this.config.disableRules) {
      rules[ruleId] = { enabled: false };
    }
    if (Object.keys(rules).length > 0) {
      axeBuilder = axeBuilder.options({ rules });
    }

    // axe supports a single runOnly. An explicit rule list is the narrower,
    // more deliberate request, so it wins over tag filtering.
    if (this.config.runOnlyRules && this.config.runOnlyRules.length > 0) {
      axeBuilder = axeBuilder.withRules(this.config.runOnlyRules);
    } else if (this.config.tags.length > 0) {
      axeBuilder = axeBuilder.withTags(this.config.tags);
    }

    for (const selector of forcedInclude ? [forcedInclude] : this.config.include) {
      axeBuilder = axeBuilder.include(selector);
    }
    for (const selector of this.config.exclude) {
      axeBuilder = axeBuilder.exclude(selector);
    }

    return axeBuilder;
  }

  /**
   * Run analysis under the configured timeout. axe exposes no timeout of its own
   * (RunOptions has only the iframe-specific frameWaitTime/pingWaitTime), so the
   * bound is applied here — otherwise a hung scan blocks the run indefinitely.
   */
  private async analyzeWithTimeout(
    axeBuilder: AxeBuilder,
  ): Promise<Awaited<ReturnType<AxeBuilder['analyze']>>> {
    const { timeout } = this.config;
    if (!timeout || timeout <= 0) {
      return axeBuilder.analyze();
    }

    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        axeBuilder.analyze(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Axe analysis timed out after ${timeout}ms`)),
            timeout,
          );
        }),
      ]);
    } finally {
      // Without this the pending timer keeps the event loop alive on the happy path.
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Run axe-core accessibility tests on a page
   */
  async run(page: Page, testName: string, url: string): Promise<A11yResult> {
    try {
      const axeResults = await this.analyzeWithTimeout(this.buildAxe(page));

      // Transform violations to our format
      const violations: A11yViolation[] = axeResults.violations.map(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (violation: any) => ({
          id: violation.id,
          impact: violation.impact || 'moderate',
          tags: violation.tags || [],
          description: violation.description || '',
          help: violation.help || '',
          helpUrl: violation.helpUrl || '',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          nodes: violation.nodes.map((node: any) => ({
            target: node.target || [],
            html: node.html || '',
            failureSummary: node.failureSummary,
            element: node.target?.[0],
          })),
        }),
      );

      // Transform passes
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const passes = axeResults.passes.map((pass: any) => ({
        id: pass.id,
        description: pass.description || '',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        nodes: pass.nodes.map((node: any) => ({
          target: node.target || [],
          html: node.html || '',
        })),
      }));

      // Transform incomplete
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const incomplete = axeResults.incomplete.map((inc: any) => ({
        id: inc.id,
        description: inc.description || '',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        nodes: inc.nodes.map((node: any) => ({
          target: node.target || [],
          html: node.html || '',
        })),
      }));

      // Transform inapplicable
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const inapplicable = axeResults.inapplicable.map((inap: any) => ({
        id: inap.id,
        description: inap.description || '',
      }));

      // Create summary
      const summary = {
        total: violations.length + passes.length + incomplete.length + inapplicable.length,
        violations: violations.length,
        passes: passes.length,
        incomplete: incomplete.length,
        inapplicable: inapplicable.length,
      };

      // Get test runner info
      const testRunner = {
        name: axeResults.testEngine?.name || 'axe-core',
        // 'unknown' rather than a pinned number: a stale version stated with
        // confidence is worse than admitting axe did not report one (issue #81).
        version: axeResults.testEngine?.version ?? 'unknown',
      };

      return {
        testName,
        url,
        timestamp: new Date(),
        passed: violations.length === 0,
        violations,
        passes,
        incomplete,
        inapplicable,
        summary,
        testRunner,
      };
    } catch (error) {
      throw new Error(
        `Axe-core execution failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Run axe-core scoped to a single element.
   *
   * KEPT DELIBERATELY, though nothing in `src` calls it (issue #81 listed it as
   * dead). It is a working, tested, exported method on a class this package
   * exports — scoping a scan to one component is the obvious thing a library
   * consumer wants, and deleting it would be a breaking change to buy back ~40
   * lines. Reconsider if `AxeRunner` ever stops being public.
   */
  async runOnElement(
    page: Page,
    selector: string,
    testName: string,
    url: string,
  ): Promise<A11yResult> {
    try {
      const axeResults = await this.analyzeWithTimeout(this.buildAxe(page, selector));

      // Transform results similar to run() method
      const violations: A11yViolation[] = axeResults.violations.map(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (violation: any) => ({
          id: violation.id,
          impact: violation.impact || 'moderate',
          tags: violation.tags || [],
          description: violation.description || '',
          help: violation.help || '',
          helpUrl: violation.helpUrl || '',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          nodes: violation.nodes.map((node: any) => ({
            target: node.target || [],
            html: node.html || '',
            failureSummary: node.failureSummary,
            element: node.target?.[0],
          })),
        }),
      );

      return {
        testName: `${testName}_${selector}`,
        url,
        timestamp: new Date(),
        passed: violations.length === 0,
        violations,
        passes: [],
        incomplete: [],
        inapplicable: [],
        summary: {
          total: violations.length,
          violations: violations.length,
          passes: 0,
          incomplete: 0,
          inapplicable: 0,
        },
        testRunner: {
          // Derived from the engine that actually ran. This used to be a
          // hardcoded '4.8.0' while the installed axe-core was 4.10.3, so every
          // element-scan report attributed its findings to a version that never
          // produced them (issue #81).
          name: axeResults.testEngine?.name || 'axe-core',
          version: axeResults.testEngine?.version ?? 'unknown',
        },
      };
    } catch (error) {
      throw new Error(
        `Axe-core element scan failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Get severity count from results
   */
  getSeverityCounts(result: A11yResult): Record<string, number> {
    const counts: Record<string, number> = {
      critical: 0,
      serious: 0,
      moderate: 0,
      minor: 0,
    };

    result.violations.forEach((violation) => {
      const impact = violation.impact || 'moderate';
      counts[impact] = (counts[impact] || 0) + 1;
    });

    return counts;
  }

  /**
   * Check if result passes based on failure threshold
   */
  checkThreshold(result: A11yResult, threshold: Record<string, boolean>): boolean {
    for (const violation of result.violations) {
      const impact = violation.impact || 'moderate';
      if (threshold[impact]) {
        return false; // Fail if any violation matches the threshold
      }
    }
    return true;
  }
}
