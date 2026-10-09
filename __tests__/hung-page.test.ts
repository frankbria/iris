/**
 * A page whose main thread never yields (#293).
 *
 * `page.title()` and `page.evaluate()` have no timeout of their own: against a
 * page spinning in `for (;;) {}` they wait forever, and so did the agent loop's
 * observation and the visual capture's metadata. Real Chromium, because only a
 * real renderer can be hung; Jest's test timeout is the bound being checked.
 */

import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { createServer, Server } from 'http';
import type { AddressInfo } from 'net';
import { observePage } from '../src/agent-loop';
import { ActionExecutor } from '../src/executor';
import { VisualCaptureEngine } from '../src/visual/capture';
import { withPageTimeout } from '../src/page-timeout';

const HUNG = `<!doctype html><html><head><title>Spinner</title></head><body>
  <p>about to hang</p>
  <script>setTimeout(() => { for (;;) {} }, 50);</script>
</body></html>`;

describe('a page that never yields', () => {
  let server: Server;
  let origin = '';
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(HUNG);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch();
  }, 60000);

  afterAll(async () => {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(async () => {
    context = await browser.newContext();
    page = await context.newPage();
    page.setDefaultTimeout(1000);
    await page.goto(origin);
    await page.waitForTimeout(200);
    // Positive control: the page really is hung, so the checks below mean something.
    await expect(withPageTimeout(page.title(), 'hung', 500)).resolves.toBe('hung');
  });

  afterEach(async () => {
    await context?.close();
  }, 15000);

  it('observePage returns a degraded digest instead of waiting forever', async () => {
    const digest = await observePage(page);

    expect(digest).toContain('TITLE: <unknown>');
    expect(digest).toContain('<accessibility snapshot unavailable>');
  }, 20000);

  it('capture fails with an error result instead of waiting forever', async () => {
    const result = await new VisualCaptureEngine().capture(page, {
      fullPage: false,
      maskSelectors: [],
      stabilizeMs: 0,
      disableAnimations: false,
      type: 'png',
    });

    expect(result.success).toBe(false);
    expect(result.metadata.title).toBe('Unknown');
  }, 20000);

  it('capture with animations off and masks fails instead of waiting forever', async () => {
    // addStyleTag runs in the page too: the default visual run reaches it first.
    const result = await new VisualCaptureEngine().capture(page, {
      fullPage: false,
      maskSelectors: ['p'],
      stabilizeMs: 0,
      disableAnimations: true,
      type: 'png',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('did not respond');
  }, 20000);

  it('capture metadata falls back rather than waiting forever', async () => {
    const metadata = await new VisualCaptureEngine().generateMetadata(page, Buffer.from('x'), {
      fullPage: false,
      maskSelectors: [],
      stabilizeMs: 0,
      disableAnimations: false,
      type: 'png',
    });

    expect(metadata.title).toBe('Unknown');
    expect(metadata.viewport).toEqual(page.viewportSize());
  }, 20000);

  it('the executor page context keeps its URL and drops the title', async () => {
    const executor = new ActionExecutor({ timeout: 1000, retryAttempts: 0, trackContext: false });

    const context = await executor.getPageContext(page);

    expect(context.url).toBe(`${origin}/`);
    expect(context.title).toBeUndefined();
  }, 20000);
});

describe('withPageTimeout', () => {
  it('passes a settled call through', async () => {
    await expect(withPageTimeout(Promise.resolve('t'), 'f', 1000)).resolves.toBe('t');
    await expect(withPageTimeout(Promise.reject(new Error('closed')), 'f', 1000)).rejects.toThrow(
      'closed',
    );
  });

  it('answers the fallback when the call never settles', async () => {
    await expect(withPageTimeout(new Promise<string>(() => {}), 'f', 10)).resolves.toBe('f');
  });
});
