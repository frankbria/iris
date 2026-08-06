/**
 * MCP tool definitions for IRIS (plan 012 — spike scope: one tool).
 *
 * `run_accessibility_test` wraps the same `AccessibilityRunner` the `iris a11y`
 * CLI command drives, so the two transports share one engine. It deliberately
 * exposes ONLY the axe-core violations: the keyboard and screen-reader
 * sub-checks currently hardcode success (issues #73 and #72), and reporting a
 * fabricated "keyboard: passed" to an assistant would be worse than silence.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AccessibilityRunner } from '../a11y/a11y-runner';
import { assertNavigationAllowed } from '../url-policy';

export const RUN_ACCESSIBILITY_TEST = 'run_accessibility_test';

/** axe tag sets per WCAG conformance level. AAA is additive over AA. */
const WCAG_TAGS = {
  AA: ['wcag2a', 'wcag2aa'],
  AAA: ['wcag2a', 'wcag2aa', 'wcag2aaa'],
} as const;

const inputSchema = {
  url: z
    .string()
    .describe('Absolute http(s) URL of the page to scan, e.g. http://localhost:3000/checkout'),
  wcagLevel: z
    .enum(['AA', 'AAA'])
    .optional()
    .describe('WCAG conformance level to check against. Defaults to AA.'),
};

const outputSchema = {
  url: z
    .string()
    .describe('The URL actually scanned. Differs from the request when it redirected.'),
  passed: z.boolean().describe('True when axe-core reported no violations at all.'),
  violationCount: z.number().describe('Total number of distinct axe rules violated.'),
  violations: z
    .array(
      z.object({
        id: z.string().describe('axe rule id, e.g. "image-alt".'),
        impact: z.enum(['minor', 'moderate', 'serious', 'critical']),
        description: z.string(),
        helpUrl: z.string().describe('Deque documentation for the rule.'),
        nodes: z.number().describe('How many elements on the page violate this rule.'),
      }),
    )
    .describe('One entry per violated axe rule. Empty when the page passes.'),
};

/** Shape of a failed tool call: a message the assistant can act on, never a throw. */
function toolError(message: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
  };
}

/**
 * The first line of an error is the reason; Playwright appends a multi-line
 * call log with ANSI colour codes after it. An assistant reading a tool result
 * needs the reason — a terminal dump is noise it has to pay tokens to skip.
 */
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0].trim();
}

/**
 * Build the runner config for a single-page, axe-only scan.
 *
 * Keyboard and screen-reader flags are all false so `AccessibilityRunner` skips
 * those passes entirely, and `output` is omitted so the run writes no report
 * file — an MCP server answering a tool call should not leave artifacts behind.
 */
function scanConfig(url: string, wcagLevel: 'AA' | 'AAA') {
  return {
    pages: [url],
    axe: {
      rules: {},
      tags: [...WCAG_TAGS[wcagLevel]],
      include: [],
      exclude: [],
      disableRules: [],
      timeout: 30000,
    },
    keyboard: {
      testFocusOrder: false,
      testTrapDetection: false,
      testArrowKeyNavigation: false,
      testEscapeHandling: false,
      customSequences: [],
    },
    screenReader: {
      testAriaLabels: false,
      testLandmarkNavigation: false,
      testImageAltText: false,
      testHeadingStructure: false,
      simulateScreenReader: false,
    },
    failureThreshold: { critical: true, serious: true },
    // The pre-flight assertNavigationAllowed() below only sees the URL the model
    // handed us. This applies the policy to every request that follows too, so
    // neither a 30x redirect nor a sub-resource can reach a host the model was
    // not allowed to name directly.
    urlPolicy: {},
  };
}

export function registerTools(server: McpServer): void {
  server.registerTool(
    RUN_ACCESSIBILITY_TEST,
    {
      title: 'Run accessibility test',
      description:
        'Scan a web page with axe-core and report WCAG violations. Runs a real headless browser, ' +
        'so the URL must be reachable from this machine. Returns axe-core violations only — it does ' +
        'not test keyboard navigation or screen-reader behaviour.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ url, wcagLevel }) => {
      // The URL arrives from an assistant and may be model-generated from
      // untrusted page content, so it crosses the same trust boundary the RPC
      // navigate path does. Reuse that gate rather than inventing a second one.
      try {
        assertNavigationAllowed(url);
      } catch (error) {
        return toolError(describeError(error));
      }

      let result;
      try {
        const runner = new AccessibilityRunner(scanConfig(url, wcagLevel ?? 'AA'));
        result = await runner.run();
      } catch (error) {
        return toolError(`Accessibility scan failed for ${url}: ${describeError(error)}`);
      }

      const axeResult = result.results[0]?.axeResult;
      if (!axeResult) {
        return toolError(`Accessibility scan returned no result for ${url}.`);
      }

      const violations = axeResult.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        description: violation.description,
        helpUrl: violation.helpUrl,
        nodes: violation.nodes.length,
      }));

      // The URL that was actually measured, which differs from the requested one
      // when it redirected. Reporting the request URL would misattribute every
      // violation on the page the scan really landed on.
      const scannedUrl = axeResult.url || url;
      const redirectNote = scannedUrl === url ? '' : ` (redirected from ${url})`;

      const structuredContent = {
        url: scannedUrl,
        passed: violations.length === 0,
        violationCount: violations.length,
        violations,
      };

      const summary = structuredContent.passed
        ? `No WCAG ${wcagLevel ?? 'AA'} violations found on ${scannedUrl}${redirectNote}.`
        : `${violations.length} WCAG ${wcagLevel ?? 'AA'} violation(s) on ${scannedUrl}${redirectNote}:\n` +
          violations.map((v) => `- [${v.impact}] ${v.id}: ${v.description}`).join('\n');

      return {
        content: [{ type: 'text' as const, text: summary }],
        structuredContent,
      };
    },
  );
}
