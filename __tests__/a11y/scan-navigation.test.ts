/**
 * A scan's checks stay on the document they were started on (#669).
 *
 * Real Chromium, launched through Playwright itself, and a real HTTP server: the pages move
 * on by themselves after their network went idle, which is what the a11y runner cannot see
 * when it reads the document's URL once. Each test decides when its check ends relative to
 * the move (it waits for the move, or cannot outlive it), so no outcome depends on how fast
 * the machine is.
 */

import { once } from 'events';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { chromium, Browser, Page } from 'playwright';
import { AxeRunner } from '../../src/a11y/axe-integration';
import { KeyboardTester } from '../../src/a11y/keyboard-tester';
import {
  HeldDocument,
  holdDocument,
  NavigatedDuringScanError,
  onScannedDocument,
} from '../../src/a11y/scan-navigation';

const page = (head: string, script: string): string =>
  `<html lang="en"><head><title>first</title>${head}</head><body><h1>first</h1>` +
  `<script>${script}</script></body></html>`;

const PAGES: Record<string, string> = {
  '/replace-after-2s': page('', "setTimeout(() => location.replace('/second?token=s3cret'), 2000)"),
  '/meta-refresh-2s': page('<meta http-equiv="refresh" content="2;url=/second">', ''),
  '/rewrites-query-and-fragment': page(
    '',
    "setTimeout(() => history.replaceState(null, '', '?tab=2#section'), 2000)",
  ),
  '/router-pushes-a-path': page(
    '',
    "setTimeout(() => history.pushState(null, '', '/route'), 2000)",
  ),
  // Once: the second load stays, so a check may wait for it and measure it.
  '/reloads-after-2s': page(
    '',
    "if (!sessionStorage.reloaded) { sessionStorage.reloaded = '1'; setTimeout(() => location.reload(), 2000); }",
  ),
  // The same path loaded again under another query string, which is no move by its URL.
  '/same-path-other-query-after-2s': page(
    '',
    "if (!location.search) setTimeout(() => location.replace(location.pathname + '?again'), 2000)",
  ),
  '/stays': page('', ''),
  // The same path on another host: this server under its other loopback name.
  '/other-host-after-2s': page(
    '',
    "setTimeout(() => location.replace('http://localhost:' + location.port + '/other-host-after-2s?moved'), 2000)",
  ),
  // What the keyboard checks meet: links to walk, and a move no key made.
  '/links-and-replaces-after-2s': page(
    '',
    "setTimeout(() => location.replace('/second'), 2000)",
  ).replace('<h1>first</h1>', `<h1>first</h1>${'<a href="/second">a link</a> '.repeat(40)}`),
  // A dialog whose Escape handler leaves the page: a pass of the Escape check (#286).
  '/escape-leaves': page(
    '',
    "addEventListener('keydown', (e) => { if (e.key === 'Escape') location.assign('/second'); })",
  ).replace(
    '<h1>first</h1>',
    '<h1>first</h1><div role="dialog" aria-label="Notice"><button>OK</button></div>',
  ),
  // A dialog whose Escape handler loads the page again, once.
  '/escape-reloads': page(
    '',
    "addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sessionStorage.reloaded) { sessionStorage.reloaded = '1'; location.reload(); } })",
  ).replace(
    '<h1>first</h1>',
    '<h1>first</h1><div role="dialog" aria-label="Notice"><button>OK</button></div>',
  ),
  // A dialog that closes on Escape and leaves the page three seconds later.
  '/escape-leaves-after-3s': page(
    '',
    "addEventListener('keydown', (e) => { if (e.key !== 'Escape') return; document.querySelector('[role=dialog]').remove(); setTimeout(() => location.assign('/second'), 3000); })",
  ).replace(
    '<h1>first</h1>',
    '<h1>first</h1><div role="dialog" aria-label="Notice"><button>OK</button></div>',
  ),
  // A menu whose arrow key routes to another page instead of moving focus.
  '/arrow-leaves': page(
    '',
    "addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') location.assign('/second'); })",
  ).replace(
    '<h1>first</h1>',
    '<h1>first</h1><ul role="menu" aria-label="Sections">' +
      '<li role="menuitem" tabindex="0">One</li><li role="menuitem" tabindex="-1">Two</li></ul>' +
      '<ul role="menu" aria-label="More"><li role="menuitem" tabindex="0">Three</li></ul>',
  ),
  // Large enough that axe is still scanning it two seconds after its response: measured at
  // 2.9 s for a third of this size, and the move comes 1.5 s after the network went idle.
  '/large-and-replaces-after-1s': page(
    '',
    "setTimeout(() => location.replace('/second'), 2000)",
  ).replace(
    '<h1>first</h1>',
    `<h1>first</h1>${'<p>some text <a href="/second">a link</a></p>'.repeat(3000)}`,
  ),
  '/second':
    '<html lang="en"><head><title>second</title></head><body><h1>second</h1></body></html>',
};

describe('onScannedDocument', () => {
  let browser: Browser;
  let server: Server;
  let origin: string;
  let tab: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
    server = createServer((req, res) => {
      const [path, query] = (req.url ?? '').split('?');
      res.setHeader('Content-Type', 'text/html');
      res.end((query === 'moved' ? undefined : PAGES[path]) ?? PAGES['/second']);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(async () => {
    tab = await (await browser.newContext()).newPage();
  });

  afterEach(async () => {
    await tab.context().close();
  });

  /**
   * The page as the runner has it when its checks begin: loaded, idle, its URL read. Every
   * fixture moves two seconds after its response, the network is idle after half a
   * second, and the URL read here is checked to be the first page's: a move that came
   * first would make the test about nothing.
   */
  async function scanned(path: string): Promise<HeldDocument> {
    await tab.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
    const held = await holdDocument(tab, tab.url());
    expect(held.url).toBe(`${origin}${path}`);
    return held;
  }

  /** The main frame's next document, whatever its URL. */
  const nextDocument = (): Promise<unknown> =>
    tab.waitForEvent('framenavigated', (frame) => frame === tab.mainFrame());

  /** A check that cannot finish on this document: only a navigation ends it. */
  const neverSettlesHere = (): Promise<unknown> => tab.evaluate('new Promise(() => {})');

  const axe = (url: string) =>
    new AxeRunner({
      rules: {},
      tags: ['wcag2a'],
      include: [],
      exclude: [],
      disableRules: [],
      timeout: 30000,
    }).run(tab, 'test', url);

  it('names the move when a delayed location.replace destroys a running check', async () => {
    const held = await scanned('/replace-after-2s');

    const outcome = onScannedDocument(tab, held, neverSettlesHere);

    await expect(outcome).rejects.toBeInstanceOf(NavigatedDuringScanError);
    await expect(outcome).rejects.toThrow(
      `The page navigated during the scan: it was at ${origin}/replace-after-2s when the scan began`,
    );
    // Where it went is the page's text, and its query string may hold a token.
    await expect(outcome).rejects.not.toThrow(/second|s3cret/);
    expect(tab.url()).toBe(`${origin}/second?token=s3cret`);
  });

  it('names the move when a meta refresh of 2 seconds destroys a running check', async () => {
    const held = await scanned('/meta-refresh-2s');

    await expect(onScannedDocument(tab, held, neverSettlesHere)).rejects.toBeInstanceOf(
      NavigatedDuringScanError,
    );
  });

  it('names the move when it comes while the real axe scan is running', async () => {
    const held = await scanned('/large-and-replaces-after-1s');

    await expect(onScannedDocument(tab, held, () => axe(held.url))).rejects.toBeInstanceOf(
      NavigatedDuringScanError,
    );
    expect(tab.url()).toBe(`${origin}/second`);
  });

  it('keeps the error of the check the move destroyed as the cause', async () => {
    const held = await scanned('/replace-after-2s');

    const error: unknown = await onScannedDocument(tab, held, neverSettlesHere).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(NavigatedDuringScanError);
    expect(String((error as Error).cause)).toMatch(/context was destroyed|navigat/i);
  });

  it('counts a move to the same path on another host', async () => {
    const held = await scanned('/other-host-after-2s');

    await expect(onScannedDocument(tab, held, neverSettlesHere)).rejects.toBeInstanceOf(
      NavigatedDuringScanError,
    );
    expect(new URL(tab.url()).hostname).toBe('localhost');
    expect(new URL(tab.url()).pathname).toBe('/other-host-after-2s');
  });

  describe('the keyboard checks, whose own keys may leave the page', () => {
    const keyboard = (checks: { testTrapDetection: boolean; testEscapeHandling: boolean }) =>
      new KeyboardTester({
        testFocusOrder: true,
        testArrowKeyNavigation: true,
        customSequences: [],
        ...checks,
      });
    const both = { testTrapDetection: true, testEscapeHandling: true };

    it('fail a page that moved on by itself while they walked it', async () => {
      const held = await scanned('/links-and-replaces-after-2s');
      const tester = keyboard(both);

      const outcome = onScannedDocument(
        tab,
        held,
        async () => {
          const result = await tester.run(tab, 'test');
          // However fast the walk was, the page has left before this check is judged.
          await tab.waitForURL(`${origin}/second`);
          return result;
        },
        () => tester.navigatedByKey,
      );

      await expect(outcome).rejects.toBeInstanceOf(NavigatedDuringScanError);
      expect(tester.navigatedByKey).toBe(false);
    });

    // Each of the two checks that press Escape on a dialog, alone and together.
    it.each([
      both,
      { testTrapDetection: true, testEscapeHandling: false },
      { testTrapDetection: false, testEscapeHandling: true },
    ])('pass a page their own Escape press left (%o)', async (checks) => {
      const held = await scanned('/escape-leaves');
      const tester = keyboard(checks);

      const result = await onScannedDocument(
        tab,
        held,
        () => tester.run(tab, 'test'),
        () => tester.navigatedByKey,
      );

      expect(tester.navigatedByKey).toBe(true);
      expect(result.passed).toBe(true);
    });

    it('pass over a page their own Escape press loaded again (#675)', async () => {
      const held = await scanned('/escape-reloads');
      const tester = keyboard({ testTrapDetection: true, testEscapeHandling: false });

      await onScannedDocument(
        tab,
        held,
        () => tester.run(tab, 'test'),
        () => tester.navigatedByKey,
      );

      expect(tester.navigatedByKey).toBe(true);
      expect(await held.replaced()).toBe(true);
    });

    it('report an arrow key that left the page, as their own move (#675)', async () => {
      const held = await scanned('/arrow-leaves');
      const tester = keyboard(both);

      const result = await onScannedDocument(
        tab,
        held,
        () => tester.run(tab, 'test'),
        () => tester.navigatedByKey,
      );

      expect(tester.navigatedByKey).toBe(true);
      expect(result.passed).toBe(false);
      // One entry: the second menu was on the page the key left.
      expect(result.interactions.filter((interaction) => interaction.key === 'ArrowDown')).toEqual([
        expect.objectContaining({
          target: 'UL',
          actualBehavior: 'The page navigated',
          success: false,
        }),
      ]);
      // The Escape check went back to the page under test instead of judging the other one.
      expect(tab.url()).toBe(`${origin}/arrow-leaves`);
    });

    // The limit (#675): nothing outside the page ties a later move to an earlier key.
    it("fail a page whose Escape handler leaves it after a delay, as the page's own move", async () => {
      const held = await scanned('/escape-leaves-after-3s');
      const tester = keyboard({ testTrapDetection: true, testEscapeHandling: false });

      const outcome = onScannedDocument(
        tab,
        held,
        async () => {
          const result = await tester.run(tab, 'test');
          expect(result.trapTests).toEqual([expect.objectContaining({ escapeMethod: 'Escape' })]);
          await tab.waitForURL(`${origin}/second`);
          return result;
        },
        () => tester.navigatedByKey,
      );

      await expect(outcome).rejects.toBeInstanceOf(NavigatedDuringScanError);
      expect(tester.navigatedByKey).toBe(false);
    });

    it('forget an earlier page whose Escape press left it', async () => {
      const tester = keyboard(both);
      await scanned('/escape-leaves');
      await tester.run(tab, 'test');
      expect(tester.navigatedByKey).toBe(true);

      await scanned('/stays');
      await tester.run(tab, 'test');

      expect(tester.navigatedByKey).toBe(false);
    });
  });

  it("keeps a check's own error when the move was the check's own", async () => {
    const held = await scanned('/stays');
    const failure = new Error('the validator failed');

    await expect(
      onScannedDocument(
        tab,
        held,
        async () => {
          await tab.goto(`${origin}/second`);
          throw failure;
        },
        () => true,
      ),
    ).rejects.toBe(failure);
  });

  it('refuses a result that was measured after the move, on the second document', async () => {
    const held = await scanned('/meta-refresh-2s');

    const measuredOnSecondPage = async () => {
      await tab.waitForURL(`${origin}/second`);
      const result = await axe(held.url);
      // The scan itself succeeded: only the comparison can tell whose result this is.
      expect(result.url).toBe(held.url);
      return result;
    };

    await expect(onScannedDocument(tab, held, measuredOnSecondPage)).rejects.toBeInstanceOf(
      NavigatedDuringScanError,
    );
  });

  it('returns the result of a page that only rewrites its query string and fragment', async () => {
    const held = await scanned('/rewrites-query-and-fragment');

    const result = await onScannedDocument(tab, held, async () => {
      await tab.waitForURL(`${origin}/rewrites-query-and-fragment?tab=2#section`);
      return axe(held.url);
    });

    expect(result.url).toBe(held.url);
    expect(tab.url()).toBe(`${origin}/rewrites-query-and-fragment?tab=2#section`);
  });

  it('counts a router that pushes another path as a move, though the document is the same', async () => {
    const held = await scanned('/router-pushes-a-path');

    await expect(
      onScannedDocument(tab, held, async () => {
        await tab.waitForURL(`${origin}/route`);
        return 'measured';
      }),
    ).rejects.toBeInstanceOf(NavigatedDuringScanError);
  });

  it('returns the result of a page that stays', async () => {
    const held = await scanned('/stays');

    const result = await onScannedDocument(tab, held, () => axe(held.url));

    expect(result.summary.violations).toBe(0);
  });

  it("keeps a check's own error when the page did not move", async () => {
    const held = await scanned('/stays');
    const failure = new Error('axe-core did not answer');

    await expect(onScannedDocument(tab, held, () => Promise.reject(failure))).rejects.toBe(failure);
  });

  describe('a document loaded again under the same path (#675)', () => {
    it('names the reload that destroys a running check', async () => {
      const held = await scanned('/reloads-after-2s');

      const outcome = onScannedDocument(tab, held, neverSettlesHere);

      await expect(outcome).rejects.toBeInstanceOf(NavigatedDuringScanError);
      await expect(outcome).rejects.toThrow(
        `The page navigated during the scan: it was at ${origin}/reloads-after-2s when the scan ` +
          'began and loaded again before its checks finished',
      );
      expect(tab.url()).toBe(`${origin}/reloads-after-2s`);
    });

    it('refuses a result that was measured after the reload, on the second document', async () => {
      const held = await scanned('/reloads-after-2s');

      const measuredOnSecondLoad = async () => {
        await nextDocument();
        return axe(held.url);
      };

      await expect(onScannedDocument(tab, held, measuredOnSecondLoad)).rejects.toThrow(
        'loaded again before its checks finished',
      );
    });

    it('names a load of the same path under another query string', async () => {
      const held = await scanned('/same-path-other-query-after-2s');

      await expect(onScannedDocument(tab, held, neverSettlesHere)).rejects.toThrow(
        'loaded again before its checks finished',
      );
      expect(tab.url()).toBe(`${origin}/same-path-other-query-after-2s?again`);
    });

    it('tells a held document that was replaced from one that was only renamed', async () => {
      const reloaded = await scanned('/reloads-after-2s');
      await nextDocument();
      expect(await reloaded.replaced()).toBe(true);

      const renamed = await scanned('/rewrites-query-and-fragment');
      await tab.waitForURL(`${origin}/rewrites-query-and-fragment?tab=2#section`);
      expect(await renamed.replaced()).toBe(false);
    });
  });

  it("keeps a check's own error when the page was closed under it", async () => {
    const held = await scanned('/stays');
    const failure = new Error('Target closed');

    await expect(
      onScannedDocument(tab, held, async () => {
        await tab.close();
        throw failure;
      }),
    ).rejects.toBe(failure);
  });
});
