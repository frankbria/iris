/**
 * IRIS's own visual HTML report is accessible (#322): it passes `iris a11y` at WCAG 2.2 AA.
 *
 * Test strategy: a report generated from a passing and a failing comparison with real image
 * files, scanned by the same `AccessibilityRunner` the CLI uses (axe at AA plus the real
 * keyboard checks), from a `file://` URL as `iris a11y` would. The toggle state that used to
 * be colour-only is checked in Chromium by clicking a filter.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import sharp from 'sharp';
import { AccessibilityRunner } from '../../src/a11y/a11y-runner';
import { wcagTags } from '../../src/a11y/wcag';
import { launchBrowser } from '../../src/browser';
import { VisualReporter } from '../../src/visual/reporter';
import type { VisualTestResult } from '../../src/visual/visual-runner';

let dir: string;
let reportUrl: string;
let html: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-report-a11y-'));
  const png = async (name: string) => {
    const file = path.join(dir, name);
    await sharp({ create: { width: 40, height: 30, channels: 3, background: '#888' } })
      .png()
      .toFile(file);
    return file;
  };
  const results: VisualTestResult = {
    summary: {
      totalComparisons: 2,
      passed: 1,
      failed: 1,
      newBaselines: 0,
      overallStatus: 'failed',
      severityCounts: { breaking: 1, moderate: 0, minor: 0 },
    },
    results: [
      {
        page: '/home',
        device: 'desktop',
        passed: true,
        similarity: 1,
        pixelDifference: 0,
        threshold: 0.1,
        screenshotPath: await png('home.png'),
        baselinePath: await png('home-base.png'),
      },
      {
        page: '/about',
        device: 'mobile',
        passed: false,
        similarity: 0.85,
        pixelDifference: 300,
        threshold: 0.1,
        ssim: 0.78,
        severity: 'breaking',
        screenshotPath: await png('about.png'),
        baselinePath: await png('about-base.png'),
        diffPath: await png('about-diff.png'),
      },
    ],
    duration: 5000,
  } as VisualTestResult;
  const out = path.join(dir, 'report.html');
  await new VisualReporter({ format: 'html', outputPath: out }).generateReport(results);
  reportUrl = pathToFileURL(out).href;
  html = fs.readFileSync(out, 'utf8');
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

it('passes iris a11y at AA: no axe violation, keyboard checks pass', async () => {
  const run = await new AccessibilityRunner({
    pages: [reportUrl],
    axe: {
      rules: {},
      tags: wcagTags('AA'),
      include: [],
      exclude: [],
      disableRules: [],
      timeout: 30000,
    },
    keyboard: {
      testFocusOrder: true,
      testTrapDetection: true,
      testArrowKeyNavigation: true,
      testEscapeHandling: true,
      customSequences: [],
    },
    screenReader: {
      testAriaLabels: false,
      testLandmarkNavigation: false,
      testImageAltText: false,
      testHeadingStructure: false,
      simulateScreenReader: false,
    },
    failureThreshold: { critical: true, serious: true, moderate: true, minor: true },
    urlPolicy: { allowFile: true },
  }).run();
  const page = run.results[0];
  expect(page.error).toBeUndefined();
  expect(page.axeResult?.violations.map((v) => v.id)).toEqual([]);
  expect(page.passed).toBe(true);
}, 120_000);

it('has a main landmark and says what each image shows', () => {
  expect(html).toMatch(/<main class="container">/);
  expect(html).toContain('alt="Baseline screenshot of /about (mobile)"');
  expect(html).toContain('alt="Current screenshot of /about (mobile)"');
  expect(html).toContain('alt="Differences between baseline and current of /about (mobile)"');
});

it('states the pressed filter, not only by colour', async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(reportUrl);
    // A string, not a function: under --coverage a function sent to the page fails.
    const pressed = () =>
      page.evaluate(
        "[...document.querySelectorAll('.filter-btn')].map((b) => b.textContent.trim() + '=' + b.getAttribute('aria-pressed'))",
      ) as Promise<string[]>;
    expect(await pressed()).toContain('All Tests=true');
    await page.click('text=Failed Only');
    expect(await pressed()).toEqual(
      expect.arrayContaining(['All Tests=false', 'Failed Only=true']),
    );
  } finally {
    await browser.close();
  }
}, 60_000);
