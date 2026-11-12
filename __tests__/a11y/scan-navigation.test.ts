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
import { NavigatedDuringScanError, onScannedDocument } from '../../src/a11y/scan-navigation';

const page = (head: string, script: string): string =>
  `<html lang="en"><head><title>first</title>${head}</head><body><h1>first</h1>` +
  `<script>${script}</script></body></html>`;

const PAGES: Record<string, string> = {
  '/replace-after-1s': page('', "setTimeout(() => location.replace('/second?token=s3cret'), 1000)"),
  '/meta-refresh-2s': page('<meta http-equiv="refresh" content="2;url=/second">', ''),
  '/rewrites-query-and-fragment': page(
    '',
    "setTimeout(() => history.replaceState(null, '', '?tab=2#section'), 1000)",
  ),
  '/router-pushes-a-path': page(
    '',
    "setTimeout(() => history.pushState(null, '', '/route'), 1000)",
  ),
  '/reloads-after-1s': page('', 'setTimeout(() => location.reload(), 1000)'),
  '/stays': page('', ''),
  // Large enough that axe is still scanning it a second after its response: measured at
  // 2.9 s for a third of this size, and the move comes 0.5 s after the network went idle.
  '/large-and-replaces-after-1s': page(
    '',
    "setTimeout(() => location.replace('/second'), 1000)",
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
      const path = (req.url ?? '').split('?')[0];
      res.setHeader('Content-Type', 'text/html');
      res.end(PAGES[path] ?? PAGES['/second']);
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
   * fixture moves a second or more after its response, the network is idle after half a
   * second, and the URL read here is checked to be the first page's: a move that came
   * first would make the test about nothing.
   */
  async function scanned(path: string): Promise<string> {
    await tab.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
    const scannedUrl = tab.url();
    expect(scannedUrl).toBe(`${origin}${path}`);
    return scannedUrl;
  }

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
    const scannedUrl = await scanned('/replace-after-1s');

    const outcome = onScannedDocument(tab, scannedUrl, neverSettlesHere);

    await expect(outcome).rejects.toBeInstanceOf(NavigatedDuringScanError);
    await expect(outcome).rejects.toThrow(
      `The page navigated during the scan: it was at ${origin}/replace-after-1s when the scan began`,
    );
    // Where it went is the page's text, and its query string may hold a token.
    await expect(outcome).rejects.not.toThrow(/second|s3cret/);
    expect(tab.url()).toBe(`${origin}/second?token=s3cret`);
  });

  it('names the move when a meta refresh of 2 seconds destroys a running check', async () => {
    const scannedUrl = await scanned('/meta-refresh-2s');

    await expect(onScannedDocument(tab, scannedUrl, neverSettlesHere)).rejects.toBeInstanceOf(
      NavigatedDuringScanError,
    );
  });

  it('names the move when it comes while the real axe scan is running', async () => {
    const scannedUrl = await scanned('/large-and-replaces-after-1s');

    await expect(onScannedDocument(tab, scannedUrl, () => axe(scannedUrl))).rejects.toBeInstanceOf(
      NavigatedDuringScanError,
    );
    expect(tab.url()).toBe(`${origin}/second`);
  });

  it('refuses a result that was measured after the move, on the second document', async () => {
    const scannedUrl = await scanned('/meta-refresh-2s');

    const measuredOnSecondPage = async () => {
      await tab.waitForURL(`${origin}/second`);
      const result = await axe(scannedUrl);
      // The scan itself succeeded: only the comparison can tell whose result this is.
      expect(result.url).toBe(scannedUrl);
      return result;
    };

    await expect(onScannedDocument(tab, scannedUrl, measuredOnSecondPage)).rejects.toBeInstanceOf(
      NavigatedDuringScanError,
    );
  });

  it('returns the result of a page that only rewrites its query string and fragment', async () => {
    const scannedUrl = await scanned('/rewrites-query-and-fragment');

    const result = await onScannedDocument(tab, scannedUrl, async () => {
      await tab.waitForURL(`${origin}/rewrites-query-and-fragment?tab=2#section`);
      return axe(scannedUrl);
    });

    expect(result.url).toBe(scannedUrl);
    expect(tab.url()).toBe(`${origin}/rewrites-query-and-fragment?tab=2#section`);
  });

  it('counts a router that pushes another path as a move, though the document is the same', async () => {
    const scannedUrl = await scanned('/router-pushes-a-path');

    await expect(
      onScannedDocument(tab, scannedUrl, async () => {
        await tab.waitForURL(`${origin}/route`);
        return 'measured';
      }),
    ).rejects.toBeInstanceOf(NavigatedDuringScanError);
  });

  it('returns the result of a page that stays', async () => {
    const scannedUrl = await scanned('/stays');

    const result = await onScannedDocument(tab, scannedUrl, () => axe(scannedUrl));

    expect(result.summary.violations).toBe(0);
  });

  it("keeps a check's own error when the page did not move", async () => {
    const scannedUrl = await scanned('/stays');
    const failure = new Error('axe-core did not answer');

    await expect(onScannedDocument(tab, scannedUrl, () => Promise.reject(failure))).rejects.toBe(
      failure,
    );
  });

  // The limit the module documents: the same path is the same page to this comparison.
  it("keeps a check's own error when the page reloaded under it", async () => {
    const scannedUrl = await scanned('/reloads-after-1s');

    const outcome = onScannedDocument(tab, scannedUrl, neverSettlesHere);

    await expect(outcome).rejects.not.toBeInstanceOf(NavigatedDuringScanError);
    await expect(outcome).rejects.toThrow(/context was destroyed|navigat/i);
  });

  it("keeps a check's own error when the page was closed under it", async () => {
    const scannedUrl = await scanned('/stays');
    const failure = new Error('Target closed');

    await expect(
      onScannedDocument(tab, scannedUrl, async () => {
        await tab.close();
        throw failure;
      }),
    ).rejects.toBe(failure);
  });
});
