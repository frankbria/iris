/**
 * Axe-core Integration Module
 *
 * Provides integration with axe-core for WCAG 2.1 compliance testing
 */

import { Page } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import type { A11yResult, A11yViolation } from './types';

export interface AxeConfig {
  rules: Record<string, { enabled: boolean }>;
  tags: string[];
  include: string[];
  exclude: string[];
  disableRules: string[];
  timeout: number;
}

export interface AxeRunOptions {
  runOnly?: {
    type: 'tag' | 'rule';
    values: string[];
  };
  rules?: Record<string, { enabled: boolean }>;
  resultTypes?: string[];
  selectors?: boolean;
  ancestry?: boolean;
  xpath?: boolean;
  absolutePaths?: boolean;
  iframes?: boolean;
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
   * Run axe-core accessibility tests on a page
   */
  async run(page: Page, testName: string, url: string): Promise<A11yResult> {
    try {
      // Create axe builder
      let axeBuilder = new AxeBuilder({ page });

      // Configure with tags
      if (this.config.tags.length > 0) {
        axeBuilder = axeBuilder.withTags(this.config.tags);
      }

      // Disable specific rules if configured
      if (this.config.disableRules.length > 0) {
        axeBuilder = axeBuilder.disableRules(this.config.disableRules);
      }

      // Run axe-core analysis
      const axeResults = await axeBuilder.analyze();

      // Transform violations to our format
      const violations: A11yViolation[] = axeResults.violations.map((violation: any) => ({
        id: violation.id,
        impact: violation.impact || 'moderate',
        tags: violation.tags || [],
        description: violation.description || '',
        help: violation.help || '',
        helpUrl: violation.helpUrl || '',
        nodes: violation.nodes.map((node: any) => ({
          target: node.target || [],
          html: node.html || '',
          failureSummary: node.failureSummary,
          element: node.target?.[0]
        }))
      }));

      // Transform passes
      const passes = axeResults.passes.map((pass: any) => ({
        id: pass.id,
        description: pass.description || '',
        nodes: pass.nodes.map((node: any) => ({
          target: node.target || [],
          html: node.html || ''
        }))
      }));

      // Transform incomplete
      const incomplete = axeResults.incomplete.map((inc: any) => ({
        id: inc.id,
        description: inc.description || '',
        nodes: inc.nodes.map((node: any) => ({
          target: node.target || [],
          html: node.html || ''
        }))
      }));

      // Transform inapplicable
      const inapplicable = axeResults.inapplicable.map((inap: any) => ({
        id: inap.id,
        description: inap.description || ''
      }));

      // Create summary
      const summary = {
        total: violations.length + passes.length + incomplete.length + inapplicable.length,
        violations: violations.length,
        passes: passes.length,
        incomplete: incomplete.length,
        inapplicable: inapplicable.length
      };

      // Get test runner info
      const testRunner = {
        name: axeResults.testEngine?.name || 'axe-core',
        version: axeResults.testEngine?.version || '4.8.0'
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
        testRunner
      };

    } catch (error) {
      throw new Error(`Axe-core execution failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Run axe-core on specific element
   */
  async runOnElement(page: Page, selector: string, testName: string, url: string): Promise<A11yResult> {
    try {
      let axeBuilder = new AxeBuilder({ page })
        .include(selector);

      if (this.config.tags.length > 0) {
        axeBuilder = axeBuilder.withTags(this.config.tags);
      }

      const axeResults = await axeBuilder.analyze();

      // Transform results similar to run() method
      const violations: A11yViolation[] = axeResults.violations.map((violation: any) => ({
        id: violation.id,
        impact: violation.impact || 'moderate',
        tags: violation.tags || [],
        description: violation.description || '',
        help: violation.help || '',
        helpUrl: violation.helpUrl || '',
        nodes: violation.nodes.map((node: any) => ({
          target: node.target || [],
          html: node.html || '',
          failureSummary: node.failureSummary,
          element: node.target?.[0]
        }))
      }));

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
          inapplicable: 0
        },
        testRunner: {
          name: 'axe-core',
          version: '4.8.0'
        }
      };

    } catch (error) {
      throw new Error(`Axe-core element scan failed: ${error instanceof Error ? error.message : String(error)}`);
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
      minor: 0
    };

    result.violations.forEach(violation => {
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
