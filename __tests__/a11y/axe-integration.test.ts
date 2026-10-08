/**
 * Axe Integration Tests
 *
 * Real Chromium and the real axe-core (no AxeBuilder mocks). axe runs in a CDP isolated
 * world (#350): the page's own JavaScript shares the DOM with it but nothing else, so a page
 * that pins `window.axe` or poisons builtins cannot write its own verdict. The tests below
 * check that, that iframes (same-process and cross-site, also out of process) are still
 * scanned, and that every configuration knob behaves as it did through AxeBuilder.
 */

import http from 'http';
import { AddressInfo } from 'net';
import { chromium, Browser, Page } from 'playwright';
import { AxeRunner, toA11yResult } from '../../src/a11y/axe-integration';
import type { AxeConfig } from '../../src/a11y/axe-integration';
import type { A11yResult } from '../../src/a11y/types';

const AXE_VERSION: string = require('axe-core/package.json').version;

const defaultConfig: AxeConfig = {
  rules: {},
  tags: ['wcag2a', 'wcag2aa'],
  include: [],
  exclude: [],
  disableRules: [],
  timeout: 30000,
};

/** A page with one image-alt (wcag2a) and one color-contrast (wcag2aa) violation. */
const TWO_VIOLATIONS = `<html lang="en"><title>t</title><main>
  <img src="x.png" id="img">
  <p id="low" style="color:#eee;background:#fff">low contrast</p>
</main></html>`;

const ids = (r: A11yResult) => r.violations.map((v) => v.id).sort();
const targets = (r: A11yResult) =>
  r.violations.flatMap((v) => v.nodes.map((n) => `${v.id}:${JSON.stringify(n.target)}`)).sort();

describe('AxeRunner', () => {
  let browser: Browser;
  let axeRunner: AxeRunner;

  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser.close();
  });
  beforeEach(() => {
    axeRunner = new AxeRunner(defaultConfig);
  });

  /** A fresh context per page: the scan opens CDP sessions on it. */
  async function pageWith(html: string, b: Browser = browser): Promise<Page> {
    const context = await b.newContext();
    const page = await context.newPage();
    await page.setContent(html);
    return page;
  }

  async function scan(html: string, config: Partial<AxeConfig> = {}): Promise<A11yResult> {
    const page = await pageWith(html);
    try {
      return await new AxeRunner({ ...defaultConfig, ...config }).run(page, 'test', 'about:blank');
    } finally {
      await page.context().close();
    }
  }

  describe('run', () => {
    it('returns violations, passes and the engine that actually ran', async () => {
      const result = await scan(TWO_VIOLATIONS);
      expect(ids(result)).toEqual(['color-contrast', 'image-alt']);
      expect(result.passed).toBe(false);
      expect(result.passes.length).toBeGreaterThan(0);
      expect(result.inapplicable.length).toBeGreaterThan(0);
      expect(result.summary.violations).toBe(2);
      expect(result.testRunner).toEqual({ name: 'axe-core', version: AXE_VERSION });
      const img = result.violations.find((v) => v.id === 'image-alt')!;
      expect(img.impact).toBe('critical');
      expect(img.nodes[0]).toMatchObject({ target: ['#img'], element: '#img' });
      expect(img.nodes[0].html).toContain('<img');
      expect(result.timestamp).toBeInstanceOf(Date);
    });

    it('passes a clean page', async () => {
      const result = await scan('<html lang="en"><title>t</title><main><h1>Hi</h1></main></html>');
      expect(result.violations).toEqual([]);
      expect(result.passed).toBe(true);
    });

    it('wraps a failed scan in an execution error', async () => {
      const page = await pageWith(TWO_VIOLATIONS);
      await page.context().close();
      await expect(axeRunner.run(page, 'test', 'about:blank')).rejects.toThrow(
        /^Axe-core execution failed: /,
      );
    });
  });

  // #350: axe used to run in the page's main world, where the page under test could answer
  // in its place.
  describe('execution context (#350)', () => {
    it("ignores a page's pinned window.axe and reports what axe-core finds", async () => {
      const result = await scan(`<html lang="en"><title>t</title><script>
        Object.defineProperty(window, 'axe', {
          value: Object.freeze({
            version: '${AXE_VERSION}',
            run: () => Promise.resolve({ violations: [], passes: [], incomplete: [], inapplicable: [] }),
            configure() {},
          }),
          writable: false,
          configurable: false,
        });
      </script><main><img src="x.png" id="img"></main></html>`);
      expect(ids(result)).toEqual(['image-alt']);
      expect(result.passed).toBe(false);
    });

    it('is unaffected by builtins the page poisons', async () => {
      const result = await scan(`<html lang="en"><title>t</title><script>
        Array.prototype.filter = function () { return []; };
        Array.prototype.map = function () { return []; };
        JSON.parse = () => ({});
        Promise.prototype.then = function () { return this; };
      </script><main><img src="x.png" id="img"></main></html>`);
      expect(ids(result)).toEqual(['image-alt']);
    });

    it('leaves the page its own window.axe untouched', async () => {
      const page =
        await pageWith(`<html lang="en"><title>t</title><script>window.axe = { mine: true };</script>
        <main><h1>x</h1></main></html>`);
      try {
        await axeRunner.run(page, 'test', 'about:blank');
        expect(await page.evaluate('JSON.stringify(window.axe)')).toBe('{"mine":true}');
      } finally {
        await page.context().close();
      }
    });
  });

  describe('iframes', () => {
    let servers: http.Server[] = [];
    const serve = (body: string): Promise<string> =>
      new Promise((resolve) => {
        const s = http.createServer((_q, r) => {
          r.setHeader('content-type', 'text/html');
          r.end(body);
        });
        servers.push(s);
        s.listen(0, '127.0.0.1', () => resolve(String((s.address() as AddressInfo).port)));
      });
    afterEach(() => {
      servers.forEach((s) => s.close());
      servers = [];
    });

    /** Main page on 127.0.0.1 with a srcdoc frame and a frame from localhost (another site). */
    async function framedUrl(): Promise<string> {
      const childPort = await serve(
        `<html lang="en"><title>c</title><main><img src="c.png" id="child-img"></main></html>`,
      );
      const mainPort = await serve(`<html lang="en"><title>m</title><main>
        <img src="m.png" id="main-img">
        <iframe title="same" srcdoc='<html lang="en"><title>s</title><img src="s.png" id="srcdoc-img"></html>'></iframe>
        <iframe title="cross" src="http://localhost:${childPort}/"></iframe>
      </main></html>`);
      return `http://127.0.0.1:${mainPort}/`;
    }

    const EXPECTED = [
      'image-alt:["#main-img"]',
      'image-alt:["iframe[title=\\"cross\\"]","#child-img"]',
      'image-alt:["iframe[title=\\"same\\"]","#srcdoc-img"]',
    ];

    async function scanFramed(b: Browser): Promise<A11yResult> {
      const context = await b.newContext();
      const page = await context.newPage();
      try {
        await page.goto(await framedUrl(), { waitUntil: 'networkidle' });
        return await axeRunner.run(page, 'test', page.url());
      } finally {
        await context.close();
      }
    }

    it('scans same-process and cross-site frames', async () => {
      expect(targets(await scanFramed(browser))).toEqual(EXPECTED);
    });

    it('scans an out-of-process frame (site isolation forced)', async () => {
      const isolated = await chromium.launch({ args: ['--site-per-process'] });
      try {
        expect(targets(await scanFramed(isolated))).toEqual(EXPECTED);
      } finally {
        await isolated.close();
      }
    });

    it("ignores a frame's own pinned window.axe", async () => {
      const result = await scan(`<html lang="en"><title>t</title><main>
        <iframe title="f" srcdoc="<html lang=en><title>s</title><script>Object.defineProperty(window,'axe',{value:{},writable:false,configurable:false})</script><img src=s.png id=in></html>"></iframe>
      </main></html>`);
      expect(targets(result)).toEqual(['image-alt:["iframe","#in"]']);
    });

    // finishRun maps partials to frames by position: own partial first, then each child's
    // subtree depth first. A misplaced entry attributes a violation to the wrong frame.
    it('attributes violations in nested frames and their siblings to the right frame', async () => {
      const inner = `<html lang=en><title>i</title><img src=x.png id=deep></html>`;
      const outer = `<html lang=en><title>o</title><img src=x.png id=mid><iframe title=inner srcdoc='${inner}'></iframe></html>`;
      const result = await scan(`<html lang="en"><title>t</title><main>
        <iframe title="outer" srcdoc="${outer}"></iframe>
        <iframe title="sibling" srcdoc="<html lang=en><title>s</title><img src=x.png id=side></html>"></iframe>
        <img src="x.png" id="top">
      </main></html>`);
      expect(targets(result)).toEqual([
        'image-alt:["#top"]',
        'image-alt:["iframe[title=\\"outer\\"]","#mid"]',
        'image-alt:["iframe[title=\\"outer\\"]","iframe","#deep"]',
        'image-alt:["iframe[title=\\"sibling\\"]","#side"]',
      ]);
    });
  });

  describe('configuration', () => {
    it('applies the tag filter', async () => {
      expect(ids(await scan(TWO_VIOLATIONS, { tags: ['wcag2a'] }))).toEqual(['image-alt']);
      expect(ids(await scan(TWO_VIOLATIONS, { tags: ['wcag2aa'] }))).toEqual(['color-contrast']);
    });

    it('runOnlyRules takes precedence over tags', async () => {
      const result = await scan(TWO_VIOLATIONS, {
        tags: ['wcag2a'],
        runOnlyRules: ['color-contrast'],
      });
      expect(ids(result)).toEqual(['color-contrast']);
      expect(result.passes.every((p) => p.id === 'color-contrast')).toBe(true);
    });

    it('disables rules from disableRules and from rules, merged', async () => {
      expect(ids(await scan(TWO_VIOLATIONS, { disableRules: ['image-alt'] }))).toEqual([
        'color-contrast',
      ]);
      expect(
        ids(await scan(TWO_VIOLATIONS, { rules: { 'image-alt': { enabled: false } } })),
      ).toEqual(['color-contrast']);
      expect(
        ids(
          await scan(TWO_VIOLATIONS, {
            rules: { 'image-alt': { enabled: false } },
            disableRules: ['color-contrast'],
          }),
        ),
      ).toEqual([]);
    });

    it('keeps the tag filter when rules are configured', async () => {
      // AxeBuilder's options() replaced runOnly when called after withTags (#72). A rules
      // map must not widen the scan: color-contrast (wcag2aa) stays out of a wcag2a scan.
      const result = await scan(TWO_VIOLATIONS, {
        tags: ['wcag2a'],
        rules: { 'image-alt': { enabled: false } },
      });
      expect(ids(result)).toEqual([]);
      expect(result.passes.some((p) => p.id === 'color-contrast')).toBe(false);
    });

    const SPLIT = `<html lang="en"><title>t</title><main>
      <div id="a"><img src="a.png" id="ia"></div>
      <div id="b"><img src="b.png" id="ib"></div></main></html>`;

    it('reports an axe error as one line, not a stack', async () => {
      const failure = scan(TWO_VIOLATIONS, { runOnlyRules: ['no-such-rule'] });
      await expect(failure).rejects.toThrow(/unknown rule/i);
      const message = await failure.catch((e: Error) => e.message);
      expect(message).not.toContain('\n');
    });

    it('applies include selectors', async () => {
      expect(targets(await scan(SPLIT, { include: ['#a'] }))).toEqual(['image-alt:["#ia"]']);
    });

    it('applies exclude selectors', async () => {
      expect(targets(await scan(SPLIT, { exclude: ['#a'] }))).toEqual(['image-alt:["#ib"]']);
    });

    it('fails with a timeout error when the scan exceeds the configured timeout', async () => {
      await expect(scan(TWO_VIOLATIONS, { timeout: 1 })).rejects.toThrow(/timed out after 1ms/);
    });
  });

  describe('runOnElement', () => {
    it('scans only the given element', async () => {
      const page = await pageWith(`<html lang="en"><title>t</title><main>
        <div id="a"><img src="a.png" id="ia"></div><img src="b.png" id="ib"></main></html>`);
      try {
        const result = await axeRunner.runOnElement(page, '#a', 'test', 'about:blank');
        expect(result.testName).toBe('test_#a');
        expect(targets(result)).toEqual(['image-alt:["#ia"]']);
        expect(result.testRunner.version).toBe(AXE_VERSION);
      } finally {
        await page.context().close();
      }
    });

    it('wraps element-scan errors', async () => {
      const page = await pageWith(TWO_VIOLATIONS);
      await page.context().close();
      await expect(axeRunner.runOnElement(page, '#a', 'test', 'about:blank')).rejects.toThrow(
        /^Axe-core element scan failed: /,
      );
    });
  });

  // The result is checked where it comes back (#350, and the #393 comment): report writers
  // call `.map`/`.join` on these fields, so a malformed one is refused here, not there.
  describe('toA11yResult', () => {
    const valid = {
      violations: [
        {
          id: 'image-alt',
          impact: 'critical',
          tags: ['wcag2a'],
          description: 'd',
          help: 'h',
          helpUrl: 'u',
          nodes: [{ target: ['#img'], html: '<img>', failureSummary: 'f' }],
        },
      ],
      passes: [{ id: 'p', description: 'd', nodes: [{ target: [['#host', '#in']], html: 'x' }] }],
      incomplete: [],
      inapplicable: [{ id: 'i', description: 'd' }],
      testEngine: { name: 'axe-core', version: '4.13.0' },
    };

    it('maps a well-formed result, shadow-DOM targets included', () => {
      const r = toA11yResult(valid, 'n', 'u');
      expect(r.summary).toEqual({
        total: 3,
        violations: 1,
        passes: 1,
        incomplete: 0,
        inapplicable: 1,
      });
      expect(r.passes[0].nodes[0].target).toEqual([['#host', '#in']]);
      expect(r.violations[0].nodes[0].element).toBe('#img');
    });

    it('defaults a missing impact to moderate', () => {
      const r = toA11yResult(
        { ...valid, violations: [{ ...valid.violations[0], impact: null }] },
        'n',
        'u',
      );
      expect(r.violations[0].impact).toBe('moderate');
    });

    it.each([
      ['violations not an array', { violations: {} }],
      ['nodes not an array', { violations: [{ ...valid.violations[0], nodes: 'x' }] }],
      [
        'target not an array',
        { violations: [{ ...valid.violations[0], nodes: [{ target: '#a', html: '' }] }] },
      ],
      ['unknown impact', { violations: [{ ...valid.violations[0], impact: 'catastrophic' }] }],
      ['passes missing', { passes: undefined }],
      ['id not a string', { inapplicable: [{ id: {}, description: '' }] }],
    ])('refuses a result with %s', (_name, patch) => {
      expect(() => toA11yResult({ ...valid, ...patch }, 'n', 'u')).toThrow(
        /axe returned a malformed result/,
      );
    });
  });

  describe('getSeverityCounts', () => {
    it('should count violations by severity', () => {
      const result: A11yResult = {
        testName: 'test',
        url: 'https://example.com',
        timestamp: new Date(),
        passed: false,
        violations: [
          {
            id: 'critical-1',
            impact: 'critical',
            tags: [],
            description: '',
            help: '',
            helpUrl: '',
            nodes: [],
          },
          {
            id: 'critical-2',
            impact: 'critical',
            tags: [],
            description: '',
            help: '',
            helpUrl: '',
            nodes: [],
          },
          {
            id: 'serious-1',
            impact: 'serious',
            tags: [],
            description: '',
            help: '',
            helpUrl: '',
            nodes: [],
          },
          {
            id: 'moderate-1',
            impact: 'moderate',
            tags: [],
            description: '',
            help: '',
            helpUrl: '',
            nodes: [],
          },
          {
            id: 'moderate-2',
            impact: 'moderate',
            tags: [],
            description: '',
            help: '',
            helpUrl: '',
            nodes: [],
          },
          {
            id: 'moderate-3',
            impact: 'moderate',
            tags: [],
            description: '',
            help: '',
            helpUrl: '',
            nodes: [],
          },
          {
            id: 'minor-1',
            impact: 'minor',
            tags: [],
            description: '',
            help: '',
            helpUrl: '',
            nodes: [],
          },
        ],
        passes: [],
        incomplete: [],
        inapplicable: [],
        summary: {
          total: 7,
          violations: 7,
          passes: 0,
          incomplete: 0,
          inapplicable: 0,
        },
        testRunner: {
          name: 'axe-core',
          version: '4.8.0',
        },
      };

      const counts = axeRunner.getSeverityCounts(result);

      expect(counts.critical).toBe(2);
      expect(counts.serious).toBe(1);
      expect(counts.moderate).toBe(3);
      expect(counts.minor).toBe(1);
    });

    it('should return zero counts for no violations', () => {
      const result: A11yResult = {
        testName: 'test',
        url: 'https://example.com',
        timestamp: new Date(),
        passed: true,
        violations: [],
        passes: [],
        incomplete: [],
        inapplicable: [],
        summary: {
          total: 0,
          violations: 0,
          passes: 0,
          incomplete: 0,
          inapplicable: 0,
        },
        testRunner: {
          name: 'axe-core',
          version: '4.8.0',
        },
      };

      const counts = axeRunner.getSeverityCounts(result);

      expect(counts.critical).toBe(0);
      expect(counts.serious).toBe(0);
      expect(counts.moderate).toBe(0);
      expect(counts.minor).toBe(0);
    });
  });

  describe('checkThreshold', () => {
    const createResultWithViolations = (
      impacts: Array<'critical' | 'serious' | 'moderate' | 'minor'>,
    ): A11yResult => ({
      testName: 'test',
      url: 'https://example.com',
      timestamp: new Date(),
      passed: false,
      violations: impacts.map((impact) => ({
        id: `${impact}-violation`,
        impact,
        tags: [],
        description: '',
        help: '',
        helpUrl: '',
        nodes: [],
      })),
      passes: [],
      incomplete: [],
      inapplicable: [],
      summary: {
        total: impacts.length,
        violations: impacts.length,
        passes: 0,
        incomplete: 0,
        inapplicable: 0,
      },
      testRunner: {
        name: 'axe-core',
        version: '4.8.0',
      },
    });

    it('should fail when critical violations exceed threshold', () => {
      const result = createResultWithViolations(['critical']);
      const threshold = { critical: true, serious: false, moderate: false, minor: false };

      const passed = axeRunner.checkThreshold(result, threshold);

      expect(passed).toBe(false);
    });

    it('should pass when violations do not exceed threshold', () => {
      const result = createResultWithViolations(['moderate', 'minor']);
      const threshold = { critical: true, serious: true, moderate: false, minor: false };

      const passed = axeRunner.checkThreshold(result, threshold);

      expect(passed).toBe(true);
    });

    it('should fail for any violation matching threshold', () => {
      const result = createResultWithViolations(['critical', 'serious', 'moderate']);
      const threshold = { critical: false, serious: true, moderate: false, minor: false };

      const passed = axeRunner.checkThreshold(result, threshold);

      expect(passed).toBe(false);
    });

    it('should pass when no violations', () => {
      const result = createResultWithViolations([]);
      const threshold = { critical: true, serious: true, moderate: true, minor: true };

      const passed = axeRunner.checkThreshold(result, threshold);

      expect(passed).toBe(true);
    });

    it('should handle multiple severity thresholds', () => {
      const result = createResultWithViolations(['minor', 'minor', 'moderate']);
      const threshold = { critical: true, serious: true, moderate: true, minor: false };

      const passed = axeRunner.checkThreshold(result, threshold);

      expect(passed).toBe(false); // moderate is in threshold
    });
  });
});
