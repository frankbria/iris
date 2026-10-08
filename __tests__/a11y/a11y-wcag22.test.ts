/**
 * #290: `iris a11y`'s default level is WCAG 2.2 AA, and axe's `incomplete` results reach
 * the report. Real Chromium and real axe, with the CLI's default tags.
 *
 * The page breaks one rule only WCAG 2.1 has (`autocomplete-valid` is tagged `wcag21aa`
 * alone), and has text over a background image, whose contrast axe cannot compute: an
 * incomplete `color-contrast`. Before, the first was never checked and the second never
 * shown, so the HTML report said "No violations found."
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AccessibilityRunner, AccessibilityRunnerConfig } from '../../src/a11y/a11y-runner';
import { wcagTags } from '../../src/a11y/wcag';

const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
const PAGE =
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(`<!doctype html><html lang="en"><head><title>t</title></head><body><main>
  <h1>Form</h1>
  <label>Name <input type="text" autocomplete="banana"></label>
  <p style="color:#777;background-image:url('${PIXEL}')">Text over an image</p>
  </main></body></html>`);

function config(output: AccessibilityRunnerConfig['output']): AccessibilityRunnerConfig {
  return {
    pages: [PAGE],
    axe: {
      rules: {},
      tags: wcagTags('AA'),
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
    output,
  };
}

describe('WCAG 2.2 AA default and needs-review (#290)', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-290-'));
  afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

  it('finds the 2.1-only violation and lists the undecided rule in the HTML report', async () => {
    const out = path.join(work, 'r.html');
    const result = await new AccessibilityRunner(config({ format: 'html', path: out })).run();

    const axe = result.results[0].axeResult;
    expect(axe.violations.map((v) => v.id)).toEqual(['autocomplete-valid']);
    expect(axe.incomplete.map((i) => i.id)).toContain('color-contrast');

    const html = fs.readFileSync(out, 'utf8');
    expect(html).toContain('Needs manual review');
    expect(html).toMatch(/<strong>color-contrast<\/strong>/);
  }, 120_000);

  it('JUnit lists the undecided rule as output, not as a failure', async () => {
    const out = path.join(work, 'r.xml');
    await new AccessibilityRunner(config({ format: 'junit', path: out })).run();
    const xml = fs.readFileSync(out, 'utf8');

    // In the axe case's <system-out> (escapeXml writes LF as &#10;), and the case fails
    // only on the real violation.
    expect(xml).toMatch(/<system-out>[^<]*Needs manual review:&#10;color-contrast: /);
    expect(xml).toMatch(/<failure message="1 violation\(s\) at the failure threshold"/);
  }, 120_000);
});
