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

/**
 * The per-page error the a11y runner records for a page it could not scan (#287: it used
 * to throw, which ended every other page's scan too).
 */
async function a11yError(
  a11y: { AccessibilityRunner: typeof import('../src/a11y/a11y-runner').AccessibilityRunner },
  config: ReturnType<typeof a11yConfig>,
): Promise<string | undefined> {
  const result = await new a11y.AccessibilityRunner(config).run();
  expect(result.results).toHaveLength(1);
  expect(result.summary.passed).toBe(false);
  return result.results[0].error;
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
      // Pages that move on by script once their own response has arrived (#662).
      const moves: Record<string, string> = {
        '/script-moves': '/landed?token=s3cret#access_token=s3cret2',
        '/script-to-metadata': METADATA_URL,
      };
      const target = moves[req.url ?? ''];
      const script = target ? `<script>location.replace('${target}')</script>` : '';
      // Pages that move on by timer after their network went idle (#669), and large enough
      // that axe is still scanning them then: measured at 2.9 s for a third of this size,
      // against moves 0.5 s and 1.5 s after the idle point.
      const timed: Record<string, string> = {
        '/replace-after-1s': `<script>setTimeout(() => location.replace('/landed?token=s3cret'), 1000)</script>`,
        '/meta-refresh-2s': '<meta http-equiv="refresh" content="2;url=/landed?token=s3cret">',
      };
      const timedMove = timed[req.url ?? ''];
      if (timedMove) {
        const paragraphs = '<p>some text <a href="/landed">a link</a></p>'.repeat(3000);
        res.end(
          `<html lang="en"><head><title>ok</title>${timedMove}</head><body><main><h1>ok</h1>${paragraphs}</main></body></html>`,
        );
        return;
      }
      res.end(
        `<html lang="en"><head><title>ok</title></head><body>${script}<h1>ok</h1></body></html>`,
      );
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
      expect(await a11yError(a11y, a11yConfig(METADATA_URL))).toMatch(
        /blocked by navigation policy: .*link-local\/metadata/,
      );
    });

    it('a11y refuses a redirect to the metadata host', async () => {
      expect(await a11yError(a11y, a11yConfig(`${origin}/to-metadata`))).toMatch(
        /redirects to http:\/\/169\.254\.169\.254\/.*blocked by navigation policy/,
      );
    });

    // #662: the response the navigation ended on is the first page; the scan is of the second.
    it('a11y reports the page a script moved on to as the one it scanned', async () => {
      const result = await new a11y.AccessibilityRunner(a11yConfig(`${origin}/script-moves`)).run();
      expect(result.results[0].error).toBeUndefined();
      // The query string as the response's URL always had it; never the fragment.
      expect(result.results[0].axeResult.url).toBe(`${origin}/landed?token=s3cret`);
      expect(hits).toEqual(['/script-moves', '/landed?token=s3cret']);
    });

    it('a11y fails the scan of a page whose script moves on to the metadata host', async () => {
      expect(await a11yError(a11y, a11yConfig(`${origin}/script-to-metadata`))).toMatch(
        /script-to-metadata redirects to http:\/\/169\.254\.169\.254\/.*blocked by navigation policy/,
      );
    });

    // #669: the URL was read on the first page, and the scan was still running when it left.
    it.each(['/replace-after-1s', '/meta-refresh-2s'])(
      'a11y fails the scan of %s, which moves on while it is scanned, by name',
      async (path) => {
        const error = await a11yError(a11y, a11yConfig(`${origin}${path}`));
        expect(error).toBe(
          `The page navigated during the scan: it was at ${origin}${path} when the scan began ` +
            'and moved to another page before its checks finished',
        );
        // The page had moved, so the error is not a guess about a scan that died otherwise.
        expect(hits).toEqual([path, '/landed?token=s3cret']);
      },
    );

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

    // #284: the visual CLI captures data: pages too (the URL used to get the base prepended).
    it('visual captures a data: page locally', async () => {
      const result = await new visual.VisualTestRunner(
        visualConfig('data:text/html,' + encodeURIComponent('<h1>hi</h1>')),
      ).run();
      expect((result.results[0] as { error?: string }).error).toBeUndefined();
      expect(result.summary.newBaselines).toBe(1);
    });

    it('a11y applies an explicit strict policy to data: (the MCP tool passes {})', async () => {
      expect(
        await a11yError(a11y, {
          ...a11yConfig('data:text/html,hi'),
          urlPolicy: {},
        }),
      ).toMatch(/blocked by navigation policy/);
    });
  });

  describe('hosted mode', () => {
    const { a11y, visual } = loadRunners(true);

    it('a11y refuses a loopback page before any request reaches it', async () => {
      expect(await a11yError(a11y, a11yConfig(`${origin}/`))).toMatch(
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

    it('visual refuses data: although local runs may open it', async () => {
      expect(await visualError(visual, 'data:text/html,hi')).toMatch(
        /blocked by navigation policy/,
      );
    });

    it('a11y refuses data: even though the unset default allows it locally', async () => {
      expect(await a11yError(a11y, a11yConfig('data:text/html,hi'))).toMatch(
        /blocked by navigation policy/,
      );
    });
  });
});
