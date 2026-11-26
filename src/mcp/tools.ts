/**
 * MCP tool definitions for IRIS (plan 012 — spike scope: one tool).
 *
 * `run_accessibility_test` wraps the same `AccessibilityRunner` the `iris a11y`
 * CLI command drives, so the two transports share one engine and one verdict: `passed`
 * is the runner's page verdict at the caller's `failOn`, whose default is the CLI's
 * `--fail-on` default (#646). The keyboard checks run when the caller asks
 * (`keyboard: true`); the screen-reader checks are not offered.
 *
 * What a call may do and what its result may say is bounded (#362): the hints do
 * not promise a read-only tool, failures carry a reason from a fixed vocabulary
 * (`./scan-errors`), a redirect's landing URL is cut to origin and path, and at
 * most {@link MAX_CONCURRENT_SCANS} browsers run at once.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AccessibilityRunner } from '../a11y/a11y-runner';
import { assertNavigationAllowed } from '../url-policy';
import { DEFAULT_FAIL_ON, IMPACTS, wcagTags, type Impact } from '../a11y/wcag';
import { log } from '../log';
import { loggedDetail, scanFailureReason, scannedPage, withoutCredentials } from './scan-errors';
import { ScanLimiter, ScanQueueFullError } from './scan-limiter';

export const RUN_ACCESSIBILITY_TEST = 'run_accessibility_test';

/** Scans running at once, each one a Chromium. */
export const MAX_CONCURRENT_SCANS = 2;
/** Calls that may wait for a slot; one more is refused at once. */
export const MAX_WAITING_SCANS = 8;

// One per process, not per server: the bound is on this machine's browsers.
// Local only: hosted MCP (./hosted.ts) queues jobs and is capped per org instead.
const scans = new ScanLimiter(MAX_CONCURRENT_SCANS, MAX_WAITING_SCANS);

const inputSchema = {
  url: z
    .string()
    .describe('Absolute http(s) URL of the page to scan, e.g. http://localhost:3000/checkout'),
  wcagLevel: z
    .enum(['AA', 'AAA'])
    .optional()
    .describe(
      'WCAG 2.2 conformance level to check against (2.0 and 2.1 criteria included). Defaults to AA.',
    ),
  failOn: z
    .array(z.enum(IMPACTS))
    .min(1)
    .optional()
    .describe(
      'Violation impacts that fail the page. Defaults to ' +
        `${JSON.stringify(DEFAULT_FAIL_ON)}, as \`iris a11y --fail-on\` does; violations ` +
        'below it are still listed.',
    ),
  keyboard: z
    .boolean()
    .optional()
    .describe(
      'Also run the keyboard checks (focus order, focus traps, arrow keys, Escape on ' +
        'dialogs) by pressing real keys. Slower; a failed check fails the page. Defaults to false.',
    ),
};

/** Failed keyboard checks reported back, and the length of each of their fields. */
export const MAX_KEYBOARD_FAILURES = 20;
const MAX_KEYBOARD_FIELD = 200;

const outputSchema = {
  url: z
    .string()
    .describe(
      'The page actually scanned. When the scan was redirected this is the landing ' +
        "page's origin and path only: its query string and fragment are left out.",
    ),
  redirected: z.boolean().describe('True when the scan landed on another URL than the request.'),
  passed: z
    .boolean()
    .describe(
      'True when no violation has an impact in failOn and, with keyboard, the keyboard ' +
        'checks passed: the verdict `iris a11y` gives the page.',
    ),
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
  needsReview: z
    .array(
      z.object({
        id: z.string().describe('axe rule id, e.g. "color-contrast".'),
        description: z.string(),
        nodes: z.number().describe('How many elements axe could not decide for this rule.'),
      }),
    )
    .describe(
      'Rules axe could not decide automatically (its "incomplete" results): a person must ' +
        'check these elements. They do not fail the scan.',
    ),
  keyboard: z
    .object({
      passed: z.boolean(),
      checks: z.number().describe('How many keyboard interactions were tried.'),
      failures: z
        .array(
          z.object({
            key: z.string(),
            target: z.string().describe('The element, as the page labels it.'),
            expected: z.string(),
            actual: z.string(),
          }),
        )
        .describe(`The failed checks, at most ${MAX_KEYBOARD_FAILURES}.`),
    })
    .optional()
    .describe('The keyboard checks. Only present when the call set keyboard: true.'),
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
 * A failed scan as the caller sees it: the request URL and a reason from the fixed
 * vocabulary. The error's own text goes to stderr, where the person running the server
 * can read it and the model cannot.
 */
function scanFailure(url: string, error: unknown) {
  const detail = describeError(error);
  log('warn', 'mcp scan failed', {
    url: withoutCredentials(url),
    detail: loggedDetail(detail, url),
  });
  return toolError(
    `Accessibility scan failed for ${withoutCredentials(url)}: ${scanFailureReason(detail)}.`,
  );
}

/**
 * Build the runner config for a single-page scan.
 *
 * The keyboard checks run only when asked, the screen-reader ones never, and `output`
 * is omitted so the run writes no report file — an MCP server answering a tool call
 * should not leave artifacts behind.
 */
function scanConfig(
  url: string,
  wcagLevel: 'AA' | 'AAA',
  failOn: readonly Impact[],
  keyboard: boolean,
) {
  return {
    pages: [url],
    axe: {
      rules: {},
      tags: wcagTags(wcagLevel),
      include: [],
      exclude: [],
      disableRules: [],
      timeout: 30000,
    },
    keyboard: {
      testFocusOrder: keyboard,
      testTrapDetection: keyboard,
      testArrowKeyNavigation: keyboard,
      testEscapeHandling: keyboard,
      customSequences: [],
    },
    screenReader: {
      testAriaLabels: false,
      testLandmarkNavigation: false,
      testImageAltText: false,
      testHeadingStructure: false,
      simulateScreenReader: false,
    },
    failureThreshold: Object.fromEntries(failOn.map((impact) => [impact, true])),
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
        'so the URL must be reachable from this machine. Returns axe-core violations, the ' +
        'rules axe could not decide (needsReview) and, with keyboard: true, the keyboard ' +
        'checks; passed is the verdict `iris a11y` gives at the same failOn. It does not test ' +
        'screen-reader behaviour. Not read-only: loading the page runs its scripts and sends ' +
        `the requests a browser visit would. At most ${MAX_CONCURRENT_SCANS} scans run at once; ` +
        `up to ${MAX_WAITING_SCANS} more calls wait their turn and further ones are refused.`,
      inputSchema,
      outputSchema,
      // Not read-only (#362): the tool navigates a real browser to a URL the model chose,
      // and cannot promise that the visit changes nothing on the site behind it.
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ url, wcagLevel, failOn = DEFAULT_FAIL_ON, keyboard = false }) => {
      // The URL arrives from an assistant and may be model-generated from
      // untrusted page content, so it crosses the same trust boundary the RPC
      // navigate path does. Reuse that gate rather than inventing a second one.
      try {
        assertNavigationAllowed(url);
      } catch (error) {
        // The policy's reason names a scheme or a host, except for a URL it could not
        // parse, which it quotes whole: credentials included, and nothing can find them
        // in text that is not a URL.
        const reason = describeError(error);
        return toolError(
          reason.includes('malformed URL') ? 'Navigation blocked: malformed URL.' : reason,
        );
      }

      let result;
      try {
        result = await scans.run(() =>
          new AccessibilityRunner(scanConfig(url, wcagLevel ?? 'AA', failOn, keyboard)).run(),
        );
      } catch (error) {
        if (error instanceof ScanQueueFullError) {
          return toolError(
            `Too many accessibility scans at once: ${MAX_CONCURRENT_SCANS} are running and ` +
              `${MAX_WAITING_SCANS} are waiting. Call again when one has finished.`,
          );
        }
        return scanFailure(url, error);
      }

      // The runner reports a page it could not scan instead of throwing (#287): that is a
      // failed scan, never "no violations".
      const page = result.results[0];
      const pageError = page?.error;
      if (pageError !== undefined) {
        return scanFailure(url, pageError);
      }

      const axeResult = page?.axeResult;
      if (!axeResult) {
        return toolError(`Accessibility scan returned no result for ${withoutCredentials(url)}.`);
      }

      const violations = axeResult.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        description: violation.description,
        helpUrl: violation.helpUrl,
        nodes: violation.nodes.length,
      }));

      // The page that was actually measured, which differs from the requested one
      // when it redirected. Reporting the request URL would misattribute every
      // violation on the page the scan really landed on.
      const { url: scannedUrl, redirected } = scannedPage(url, axeResult.url);
      const redirectNote = redirected ? ` (redirected from ${withoutCredentials(url)})` : '';

      // axe's `incomplete`: rules it could not decide (contrast over an image, ...). Dropping
      // them made such a page read as clean (#290).
      const needsReview = axeResult.incomplete.map((item) => ({
        id: item.id,
        description: item.description,
        nodes: item.nodes.length,
      }));

      // Element labels and behaviours are page text: bounded in count and length.
      const keyboardResult = keyboard ? page.keyboardResult : undefined;
      const cut = (text: string) => text.slice(0, MAX_KEYBOARD_FIELD);
      const keyboardFailures = (keyboardResult?.interactions ?? []).filter((i) => !i.success);
      const keyboardReport = keyboardResult && {
        passed: keyboardResult.passed,
        checks: keyboardResult.interactions.length,
        failures: keyboardFailures.slice(0, MAX_KEYBOARD_FAILURES).map((i) => ({
          key: cut(i.key),
          target: cut(i.target),
          expected: cut(i.expectedBehavior),
          actual: cut(i.actualBehavior),
        })),
      };

      const structuredContent = {
        url: scannedUrl,
        redirected,
        // The runner's page verdict (#288), so the tool and `iris a11y` agree (#646).
        passed: page.passed,
        violationCount: violations.length,
        violations,
        needsReview,
        ...(keyboardReport && { keyboard: keyboardReport }),
      };

      const level = wcagLevel ?? 'AA';
      const summary =
        (violations.length === 0
          ? `No WCAG ${level} violations found on ${scannedUrl}${redirectNote}.`
          : `${violations.length} WCAG ${level} violation(s) on ${scannedUrl}${redirectNote}:\n` +
            violations.map((v) => `- [${v.impact}] ${v.id}: ${v.description}`).join('\n')) +
        `\n${page.passed ? 'Passed' : 'Failed'} at failOn ${failOn.join(', ')}` +
        (keyboardReport ? ` with the keyboard checks.` : '.') +
        (keyboardReport && !keyboardReport.passed
          ? `\n${keyboardFailures.length} keyboard check(s) failed:\n` +
            keyboardReport.failures
              .map((f) => `- ${f.key} on ${f.target}: expected ${f.expected}, got ${f.actual}`)
              .join('\n')
          : '') +
        (needsReview.length === 0
          ? ''
          : `\n${needsReview.length} rule(s) need manual review:\n` +
            needsReview.map((r) => `- ${r.id}: ${r.description}`).join('\n'));

      return {
        content: [{ type: 'text' as const, text: summary }],
        structuredContent,
      };
    },
  );
}
