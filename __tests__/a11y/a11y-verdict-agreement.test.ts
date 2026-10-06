/**
 * #288: the CLI's verdict, the HTML and JUnit reports and the history must agree.
 *
 * Real Chromium and real axe, failing on `critical` only. Both pages lack `lang`: a
 * serious violation, below the threshold. Page A's menu also ignores ArrowDown (a
 * keyboard failure); page B has nothing else. So A fails and B passes, and every
 * surface must say the same. Before, HTML and JUnit ignored the keyboard result and
 * JUnit failed B's below-threshold violation, and history failed both pages.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  AccessibilityRunner,
  AccessibilityRunnerConfig,
  AccessibilityTestResult,
} from '../../src/a11y/a11y-runner';
import { recordA11yRun } from '../../src/history';
import { getA11yTestResults, initializeDatabase } from '../../src/db';

const page = (body: string) =>
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(
    `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`,
  );
const A = page(`<ul role="menu" aria-label="Menu"><li role="menuitem" tabindex="0">One</li>
  <li role="menuitem" tabindex="-1">Two</li></ul>`);
const B = page('<main><h1>Plain</h1></main>');

function config(output?: AccessibilityRunnerConfig['output']): AccessibilityRunnerConfig {
  return {
    pages: [A, B],
    axe: {
      rules: {},
      tags: ['wcag2a'],
      include: [],
      exclude: [],
      disableRules: [],
      timeout: 30000,
    },
    keyboard: {
      testFocusOrder: false,
      testTrapDetection: false,
      testArrowKeyNavigation: true,
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
    failureThreshold: { critical: true },
    ...(output && { output }),
  };
}

describe('a11y verdict agreement (#288)', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-288-'));
  let result: AccessibilityTestResult;

  beforeAll(async () => {
    result = await new AccessibilityRunner(config()).run();
  }, 120_000);
  afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

  it('decides each page once: A fails on the keyboard, B passes below the threshold', () => {
    // Both carry the serious lang violation; only the threshold makes it irrelevant.
    expect(result.results.every((r) => r.axeResult.violations.length > 0)).toBe(true);
    expect(result.results.map((r) => r.passed)).toEqual([false, true]);
    expect(result.results[0].failureReasons).toEqual([expect.stringMatching(/keyboard/i)]);
    expect(result.summary.passed).toBe(false); // the CLI exits 4 on this
  });

  it('JUnit counts the same failures: A keyboard, nothing for B', async () => {
    const out = path.join(work, 'r.xml');
    await new AccessibilityRunner(config({ format: 'junit', path: out })).run();
    const xml = fs.readFileSync(out, 'utf8');
    const suites = [...xml.matchAll(/<testsuite name="([^"]*)"[^>]*failures="(\d+)"/g)].map((m) => [
      m[1],
      Number(m[2]),
    ]);
    expect(suites).toEqual([
      [expect.anything(), 1],
      [expect.anything(), 0],
    ]);
    expect(xml).toMatch(/<testsuites [^>]*failures="1"/);
    expect(xml).toMatch(/keyboard/i);
  }, 120_000);

  it('HTML marks A failed with its reason and B passed', async () => {
    const out = path.join(work, 'r.html');
    await new AccessibilityRunner(config({ format: 'html', path: out })).run();
    const html = fs.readFileSync(out, 'utf8');
    const sections = html.split('<section class="page').slice(1);
    expect(sections).toHaveLength(2);
    expect(sections[0]).toMatch(/FAILED/);
    expect(sections[0]).toMatch(/keyboard/i);
    expect(sections[1]).toMatch(/PASSED/);
  }, 120_000);

  it('history stores the same verdict per page', () => {
    recordA11yRun(result, new Date(), new Date());
    const db = initializeDatabase(process.env.IRIS_DB_PATH!);
    try {
      const rows = getA11yTestResults(db).sort((a, b) => a.id! - b.id!);
      expect(rows.slice(-2).map((r) => r.status)).toEqual(['failed', 'passed']);
    } finally {
      db.close();
    }
  });
});
