/**
 * #287: one page that fails must not discard the others, and a report must not be lost
 * to a missing directory after the scan.
 *
 * Real Chromium and real axe. The failing page is a local server that drops the
 * connection, so the navigation error is immediate (no WSL blackhole wait, #382).
 */
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { AccessibilityRunner, AccessibilityRunnerConfig } from '../../src/a11y/a11y-runner';

const PAGE = (title: string) =>
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(`<!doctype html><html lang="en"><head><title>${title}</title></head>
    <body><main><h1>${title}</h1></main></body></html>`);

function config(
  pages: string[],
  extra: Partial<AccessibilityRunnerConfig> = {},
): AccessibilityRunnerConfig {
  return {
    pages,
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
    failureThreshold: { critical: true },
    ...extra,
  };
}

describe('a11y runner page isolation (#287)', () => {
  let server: http.Server;
  let broken = '';
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-287-'));

  beforeAll(async () => {
    // Drops every connection: Chromium fails the navigation at once (ERR_EMPTY_RESPONSE).
    server = http.createServer((req) => req.socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    broken = `http://127.0.0.1:${(server.address() as AddressInfo).port}/broken`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(work, { recursive: true, force: true });
  });

  it('reports a failing page as errored and still scans the others', async () => {
    const result = await new AccessibilityRunner(
      config([PAGE('First'), broken, PAGE('Third')]),
    ).run();

    expect(result.results.map((r) => r.page)).toEqual([PAGE('First'), broken, PAGE('Third')]);
    expect(result.results[1].error).toMatch(/net::ERR_/);
    for (const i of [0, 2]) {
      expect(result.results[i].error).toBeUndefined();
      expect(result.results[i].axeResult.passes.length).toBeGreaterThan(0); // really scanned
    }
    // An errored page is not a pass, whatever the others found.
    expect(result.summary.passed).toBe(false);
    expect(result.summary.pagesErrored).toBe(1);
    expect(result.summary.pagesTested).toBe(3);
  }, 120_000);

  it('creates the report directory before writing, so the results are not lost', async () => {
    const out = path.join(work, 'nested', 'reports', 'a11y.json');
    const result = await new AccessibilityRunner(
      config([PAGE('Only'), broken], { output: { format: 'json', path: out } }),
    ).run();

    expect(result.reportPath).toBe(out);
    const written = JSON.parse(fs.readFileSync(out, 'utf8'));
    // The errored page is in the report with its reason.
    expect(JSON.stringify(written)).toContain('net::ERR_');
  }, 120_000);

  it.each(['html', 'junit'] as const)(
    'shows a page that could not be scanned in the %s report',
    async (format) => {
      const out = path.join(work, `isolation.${format}`);
      await new AccessibilityRunner(config([broken], { output: { format, path: out } })).run();
      const report = fs.readFileSync(out, 'utf8');
      expect(report).toContain('net::ERR_');
      if (format === 'html') {
        expect(report).toContain('Could not be scanned');
        expect(report).not.toContain('No violations found');
      } else {
        expect(report).toMatch(/<error message="[^"]*net::ERR_[^"]*" type="PageError"\/>/);
        expect(report).toMatch(/<testsuites [^>]*errors="1"/);
      }
    },
    120_000,
  );
});
