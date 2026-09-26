/**
 * The visual and a11y runners enforce the navigation URL policy (#335).
 *
 * Test strategy: real Chromium through each runner, against real HTTP servers.
 * Local mode refuses the metadata host, directly and as a redirect target, since
 * that is blocked with no opt-in. Hosted mode (IRIS_HOSTED=1, read once per
 * module registry, so loaded through `jest.isolateModules`) additionally refuses
 * loopback; a request counter on the loopback server proves the refusal happened
 * before anything was sent, not after the page loaded.
 */

import { once } from 'events';
import * as fs from 'fs';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import type { AccessibilityRunnerConfig } from '../src/a11y/a11y-runner';
import type { VisualTestRunnerConfig } from '../src/visual/visual-runner';

type A11yModule = typeof import('../src/a11y/a11y-runner');
type VisualModule = typeof import('../src/visual/visual-runner');
type HostedModule = typeof import('../src/hosted');

const METADATA_URL = 'http://169.254.169.254/latest/meta-data/';

function loadRunners(hosted: boolean): { a11y: A11yModule; visual: VisualModule } {
  const prev = process.env.IRIS_HOSTED;
  if (hosted) process.env.IRIS_HOSTED = '1';
  else delete process.env.IRIS_HOSTED;
  try {
    let loaded!: { a11y: A11yModule; visual: VisualModule };
    jest.isolateModules(() => {
      // The switch is memoized on first read, so read it while the variable is set.
      (require('../src/hosted') as HostedModule).isHostedMode();
      loaded = {
        a11y: require('../src/a11y/a11y-runner') as A11yModule,
        visual: require('../src/visual/visual-runner') as VisualModule,
      };
    });
    return loaded;
  } finally {
    if (prev === undefined) delete process.env.IRIS_HOSTED;
    else process.env.IRIS_HOSTED = prev;
  }
}

function a11yConfig(url: string): AccessibilityRunnerConfig {
  return {
    pages: [url],
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
  };
}

function visualConfig(url: string): VisualTestRunnerConfig {
  return {
    pages: [url],
    baseline: { strategy: 'branch', reference: 'main' },
    capture: {
      viewport: { width: 800, height: 600 },
      fullPage: false,
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
  };
}

/** The per-page error the visual runner records in place of a comparison. */
async function visualError(visual: VisualModule, url: string): Promise<string | undefined> {
  const result = await new visual.VisualTestRunner(visualConfig(url)).run();
  expect(result.results).toHaveLength(1);
  expect(result.results[0].passed).toBe(false);
  return (result.results[0] as { error?: string }).error;
}

describe('runner URL policy', () => {
  let server: Server;
  let origin: string;
  let hits: string[];
  let cwd: string;
  let tempDir: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req.url ?? '');
      if (req.url === '/to-metadata') {
        res.writeHead(302, { Location: METADATA_URL }).end();
        return;
      }
      res.setHeader('Content-Type', 'text/html');
      res.end('<html lang="en"><head><title>ok</title></head><body><h1>ok</h1></body></html>');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise((resolve) => server.close(resolve)));

  beforeEach(() => {
    hits = [];
    // The visual runner writes baselines and screenshots relative to cwd.
    cwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-runner-policy-'));
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('local mode', () => {
    const { a11y, visual } = loadRunners(false);

    it('a11y refuses the metadata host', async () => {
      await expect(new a11y.AccessibilityRunner(a11yConfig(METADATA_URL)).run()).rejects.toThrow(
        /blocked by navigation policy: .*link-local\/metadata/,
      );
    });

    it('a11y refuses a redirect to the metadata host', async () => {
      await expect(
        new a11y.AccessibilityRunner(a11yConfig(`${origin}/to-metadata`)).run(),
      ).rejects.toThrow(/redirects to http:\/\/169\.254\.169\.254\/.*blocked by navigation policy/);
    });

    it('visual refuses the metadata host', async () => {
      expect(await visualError(visual, METADATA_URL)).toMatch(
        /blocked by navigation policy: .*link-local\/metadata/,
      );
    });

    it('visual refuses a redirect to the metadata host', async () => {
      expect(await visualError(visual, `${origin}/to-metadata`)).toMatch(
        /redirects to http:\/\/169\.254\.169\.254\/.*blocked by navigation policy/,
      );
    });

    // Guard on, but not in the way: the local dev-server workflow still works.
    it('both runners still scan a loopback page', async () => {
      const a11yResult = await new a11y.AccessibilityRunner(a11yConfig(`${origin}/`)).run();
      expect(a11yResult.results[0].axeResult.url).toBe(`${origin}/`);

      const visualResult = await new visual.VisualTestRunner(visualConfig(`${origin}/`)).run();
      expect((visualResult.results[0] as { error?: string }).error).toBeUndefined();
      expect(visualResult.summary.newBaselines).toBe(1);
    });

    // The a11y CLI scans data: pages; the always-on guard must not break that.
    it('a11y still scans a data: page when the policy is left unset', async () => {
      const result = await new a11y.AccessibilityRunner(
        a11yConfig(
          'data:text/html,' + encodeURIComponent('<html lang="en"><title>x</title></html>'),
        ),
      ).run();
      expect(result.results).toHaveLength(1);
    });

    it('a11y applies an explicit strict policy to data: (the MCP tool passes {})', async () => {
      await expect(
        new a11y.AccessibilityRunner({
          ...a11yConfig('data:text/html,hi'),
          urlPolicy: {},
        }).run(),
      ).rejects.toThrow(/blocked by navigation policy/);
    });
  });

  describe('hosted mode', () => {
    const { a11y, visual } = loadRunners(true);

    it('a11y refuses a loopback page before any request reaches it', async () => {
      await expect(new a11y.AccessibilityRunner(a11yConfig(`${origin}/`)).run()).rejects.toThrow(
        /blocked by navigation policy: .*private\/loopback/,
      );
      expect(hits).toEqual([]);
    });

    it('visual refuses a loopback page before any request reaches it', async () => {
      expect(await visualError(visual, `${origin}/`)).toMatch(
        /blocked by navigation policy: .*private\/loopback/,
      );
      expect(hits).toEqual([]);
    });

    it('a11y refuses data: even though the unset default allows it locally', async () => {
      await expect(
        new a11y.AccessibilityRunner(a11yConfig('data:text/html,hi')).run(),
      ).rejects.toThrow(/blocked by navigation policy/);
    });
  });
});
