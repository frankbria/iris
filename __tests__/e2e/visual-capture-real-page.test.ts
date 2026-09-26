/**
 * Regression test for P0.1 (issue #54): default png capture must not crash.
 *
 * The default capture path forwarded `quality` to Playwright's screenshot()
 * even for `type: 'png'`, which Playwright rejects with
 * "options.quality is unsupported for the png screenshots". Every existing
 * e2e test uses `data:` URLs, whose navigation fails first (issue #27) and so
 * masks this crash. This test serves a real page over HTTP so capture is
 * actually reached with the default png format + quality:90.
 */

import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { VisualTestRunner, VisualTestRunnerConfig } from '../../src/visual/visual-runner';
import { VisualCaptureEngine } from '../../src/visual/capture';
import { launchBrowser, newHardenedContext } from '../../src/browser';

describe('Visual capture against a real HTTP page (P0.1 regression)', () => {
  let server: Server;
  let baseURL: string;
  let tempDir: string;
  let originalCwd: string;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><h1>Hello IRIS</h1></body></html>');
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseURL = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  beforeEach(() => {
    // Runner writes baselines to `.iris` relative to cwd — isolate in a temp dir.
    originalCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-capture-real-'));
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('captures a real page with default png format without crashing', async () => {
    const config: VisualTestRunnerConfig = {
      pages: ['/'],
      baseURL,
      baseline: { strategy: 'branch', reference: 'main' },
      capture: {
        viewport: { width: 1280, height: 720 },
        fullPage: true,
        mask: [],
        format: 'png',
        quality: 90,
        stabilization: {
          waitForFonts: false,
          disableAnimations: false,
          delay: 0,
          waitForNetworkIdle: false,
          networkIdleTimeout: 1000,
        },
      },
      diff: {
        threshold: 0.1,
        semanticAnalysis: false,
        aiProvider: 'openai',
        antiAliasing: true,
        maxConcurrency: 1,
      },
      devices: ['desktop'],
      updateBaseline: true,
      failOn: 'breaking',
    };

    const result = await new VisualTestRunner(config).run();

    // Before the fix this errored with "quality is unsupported for png"; now
    // capture succeeds and a new baseline is created.
    expect(result.summary.failed).toBe(0);
    expect(result.summary.newBaselines).toBe(1);
    expect(result.results[0].passed).toBe(true);
  }, 30000);

  // The runner passes stabilizeMs: 0, so the engine's own stabilization (network
  // idle + the fonts wait) is only reached by calling it directly. Its unit test
  // mocks waitForFunction, so this is the one place the browser runs it.
  it('stabilizes and captures a real page when stabilizeMs > 0', async () => {
    const browser = await launchBrowser();
    try {
      const page = await (await newHardenedContext(browser)).newPage();
      await page.goto(`${baseURL}/`);
      const result = await new VisualCaptureEngine().capture(page, {
        fullPage: false,
        maskSelectors: [],
        stabilizeMs: 50,
        disableAnimations: true,
        quality: 90,
        type: 'png',
      });
      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
      expect(result.metadata.viewport.width).toBeGreaterThan(0);
    } finally {
      await browser.close();
    }
  }, 30000);
});
