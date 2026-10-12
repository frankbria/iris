/**
 * Real-browser execution of the `assert` action (issue #116).
 *
 * Assertions are only meaningful against a live DOM, so these drive real
 * Chromium rather than mocks. The invariant that matters most: a failing
 * assertion must arrive as `success: false`, never as a thrown exception — a
 * throw would be retried (pointlessly, the page is unchanged) and miscounted.
 */

import { chromium, Browser, Page } from 'playwright';
import http from 'http';
import type { AddressInfo } from 'net';
import { ActionExecutor } from '../src/executor';
import type { Action } from '../src/actions';

const PAGE = `<!doctype html><html lang="en"><head><title>t</title></head><body>
  <h1>Welcome back</h1>
  <button id="go">Go</button>
  <div id="hidden-box" style="display:none">secret</div>
</body></html>`;

describe('assert action execution', () => {
  let browser: Browser;
  let page: Page;
  // A real origin for URL and network cases (#504): any path serves PAGE, /slow answers
  // after 1.5 s, /app has a form whose error renders late.
  let site: http.Server;
  let origin: string;
  // Short timeout: several cases deliberately assert something absent, and the
  // default 30s would make the suite crawl.
  const executor = new ActionExecutor({ timeout: 1000, retryAttempts: 0, trackContext: false });

  beforeAll(async () => {
    browser = await chromium.launch();
    site = http.createServer((req, res) => {
      if (req.url === '/slow') {
        setTimeout(() => res.end('{"ok":false}'), 1500);
        return;
      }
      res.setHeader('content-type', 'text/html');
      if (req.url === '/app') {
        res.end(`<!doctype html><html lang="en"><head><title>t</title></head><body>
          <button id="submit" onclick="fetch('/slow').then(() => {
            const e = document.createElement('p'); e.className = 'error';
            e.textContent = 'Invalid'; document.body.append(e); })">Submit</button>
          <button id="later" onclick="setTimeout(() => {
            const e = document.createElement('p'); e.className = 'late';
            e.textContent = 'Late'; document.body.append(e); }, 1500)">Later</button>
        </body></html>`);
        return;
      }
      res.end(PAGE);
    });
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  }, 60000);

  // close() takes seconds on a loaded host (#240); beforeAll has the same budget.
  afterAll(async () => {
    await browser?.close();
    site?.close();
  }, 60000);

  beforeEach(async () => {
    page = await browser.newPage();
    await page.goto('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE));
  });

  afterEach(async () => {
    await page?.close();
  });

  const run = (action: Action) => executor.executeAction(action, page);

  // #296, in real Chromium: a click whose handler submits and then throws succeeds, and
  // the submission happens once. page.click resolves here, so nothing reaches the retry
  // loop; the executor's unit tests cover the errors that do (never repeated either).
  it('submits once when a click handler throws after submitting (#296)', async () => {
    const retrying = new ActionExecutor({
      timeout: 1000,
      retryAttempts: 3,
      retryDelay: 1,
      trackContext: false,
    });
    await page.setContent(
      `<button id="buy" onclick="window.orders = (window.orders || 0) + 1; throw new Error('after posting')">Buy</button>`,
    );

    const result = await retrying.executeAction({ type: 'click', selector: '#buy' }, page);

    expect(result.success).toBe(true);
    expect(await page.evaluate('window.orders')).toBe(1);
  });

  describe('text_visible', () => {
    it('passes when the text is on the page', async () => {
      const r = await run({ type: 'assert', kind: 'text_visible', target: 'Welcome back' });
      expect(r.success).toBe(true);
    });

    it('fails as a result, not a throw, when the text is absent', async () => {
      const r = await run({ type: 'assert', kind: 'text_visible', target: 'Nope' });
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/Assertion failed: text_visible Nope/);
    });
  });

  describe('element_visible', () => {
    it('passes for a visible element', async () => {
      expect((await run({ type: 'assert', kind: 'element_visible', target: '#go' })).success).toBe(
        true,
      );
    });

    it('fails for an element that exists but is display:none', async () => {
      const r = await run({ type: 'assert', kind: 'element_visible', target: '#hidden-box' });
      expect(r.success).toBe(false);
    });
  });

  describe('element_absent', () => {
    it('passes when the selector matches nothing', async () => {
      expect(
        (await run({ type: 'assert', kind: 'element_absent', target: '#ghost' })).success,
      ).toBe(true);
    });

    it('passes for an element that is present but hidden', async () => {
      expect(
        (await run({ type: 'assert', kind: 'element_absent', target: '#hidden-box' })).success,
      ).toBe(true);
    });

    it('fails when the element is visible', async () => {
      expect((await run({ type: 'assert', kind: 'element_absent', target: '#go' })).success).toBe(
        false,
      );
    });

    // #504: straight after an action, absence is judged once the page settled, not in a
    // one-second glance: an error rendered by a slow request, or a timer, still fails it.
    it('fails when the element appears after a slow request the click started', async () => {
      await page.goto(`${origin}/app`);
      expect((await run({ type: 'click', selector: '#submit' })).success).toBe(true);
      const r = await run({ type: 'assert', kind: 'element_absent', target: '.error' });
      expect(r.success).toBe(false);
    }, 30_000);

    it('fails when the element appears 1.5 s after the action', async () => {
      await page.goto(`${origin}/app`);
      expect((await run({ type: 'click', selector: '#later' })).success).toBe(true);
      const r = await run({ type: 'assert', kind: 'element_absent', target: '.late' });
      expect(r.success).toBe(false);
    }, 30_000);

    // A dead page has no elements, which used to read as "absent" (#240).
    it('errors, rather than passes, on a closed page', async () => {
      await page.close();
      const r = await run({ type: 'assert', kind: 'element_absent', target: '#go' });
      expect(r.success).toBe(false);
      expect(r.error).not.toMatch(/Assertion failed/);
      expect(r.error).toMatch(/closed/);
    });
  });

  describe('url_matches', () => {
    it('errors, rather than passes, on a closed page', async () => {
      await page.close();
      const r = await run({ type: 'assert', kind: 'url_matches', target: 'text/html' });
      expect(r.success).toBe(false);
      expect(r.error).not.toMatch(/Assertion failed/);
      expect(r.error).toMatch(/closed/);
    });

    // #504: matched against the parsed URL, never as a substring of the whole href.
    const urlMatches = async (at: string, target: string) => {
      await page.goto(origin + at);
      return (await run({ type: 'assert', kind: 'url_matches', target })).success;
    };

    it('a full URL matches its origin and a path prefix at segment boundaries', async () => {
      expect(await urlMatches('/shop/cart?x=1', `${origin}/shop`)).toBe(true);
      expect(await urlMatches('/shop/cart', `${origin}/shop/cart`)).toBe(true);
      expect(await urlMatches('/shop/cart', `${origin}/sh`)).toBe(false);
      expect(await urlMatches('/shop/cart', 'http://localhost:1/shop')).toBe(false);
    }, 30_000);

    it('a path matches that path or below it, and "/" only the root', async () => {
      expect(await urlMatches('/shop/cart', '/shop')).toBe(true);
      expect(await urlMatches('/shopping', '/shop')).toBe(false);
      expect(await urlMatches('/shop/cart', '/')).toBe(false);
      expect(await urlMatches('/', '/')).toBe(true);
    }, 30_000);

    it('a host matches the hostname, never the query string', async () => {
      expect(await urlMatches('/?r=example.com', 'example.com')).toBe(false);
      expect(await urlMatches('/cart', '127.0.0.1')).toBe(true);
      expect(await urlMatches('/cart', '127.0.0.1/cart')).toBe(true);
      expect(await urlMatches('/other', '127.0.0.1/cart')).toBe(false);
    }, 30_000);

    it('a bare word matches whole path segments, not part of one or the query', async () => {
      expect(await urlMatches('/shop/cart', 'cart')).toBe(true);
      expect(await urlMatches('/shop/cart', 'car')).toBe(false);
      expect(await urlMatches('/?next=cart', 'cart')).toBe(false);
    }, 30_000);

    it('fails when the path is absent', async () => {
      expect(
        (await run({ type: 'assert', kind: 'url_matches', target: '/checkout' })).success,
      ).toBe(false);
    });

    // Review catch: a single synchronous page.url() read races an SPA route
    // change or redirect kicked off by a preceding click, giving a false
    // negative. The check auto-waits like the visibility kinds do.
    it('waits for a URL that changes after the assertion begins', async () => {
      await page.goto('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE));
      // Fires after the assertion is already waiting.
      void page.evaluate(() =>
        setTimeout(() => history.pushState({}, '', '#/checkout-complete'), 300),
      );

      const r = await run({ type: 'assert', kind: 'url_matches', target: 'checkout-complete' });

      expect(r.success).toBe(true);
    });
  });

  // A failed assertion describes the page as it is. Re-reading cannot change the
  // answer, so retrying only burns the timeout again (the lesson of #75).
  it('does not retry a failing assertion', async () => {
    const retrying = new ActionExecutor({ timeout: 500, retryAttempts: 3, trackContext: false });

    // Issue #142: this inferred "did not retry" from `elapsed < 1500`, an upper
    // bound that a loaded machine breaks on its own. The retry path waits via
    // ActionExecutor#delay, so asserting that seam was never reached says the
    // same thing directly and cannot be broken by a slow box.
    const delaySpy = jest.spyOn(
      retrying as unknown as { delay(ms: number): Promise<void> },
      'delay',
    );

    const r = await retrying.executeAction(
      { type: 'assert', kind: 'text_visible', target: 'Nope' },
      page,
    );

    expect(r.success).toBe(false);
    expect(delaySpy).not.toHaveBeenCalled();
    delaySpy.mockRestore();
  });
});
