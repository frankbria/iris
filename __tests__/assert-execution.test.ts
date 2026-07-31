/**
 * Real-browser execution of the `assert` action (issue #116).
 *
 * Assertions are only meaningful against a live DOM, so these drive real
 * Chromium rather than mocks. The invariant that matters most: a failing
 * assertion must arrive as `success: false`, never as a thrown exception — a
 * throw would be retried (pointlessly, the page is unchanged) and miscounted.
 */

import { chromium, Browser, Page } from 'playwright';
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
  // Short timeout: several cases deliberately assert something absent, and the
  // default 30s would make the suite crawl.
  const executor = new ActionExecutor({ timeout: 1000, retryAttempts: 0, trackContext: false });

  beforeAll(async () => {
    browser = await chromium.launch();
  }, 60000);

  afterAll(async () => {
    await browser?.close();
  });

  beforeEach(async () => {
    page = await browser.newPage();
    await page.goto('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE));
  });

  afterEach(async () => {
    await page?.close();
  });

  const run = (action: Action) => executor.executeAction(action, page);

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
  });

  describe('url_matches', () => {
    it('passes on a substring of the current url', async () => {
      expect(
        (await run({ type: 'assert', kind: 'url_matches', target: 'text/html' })).success,
      ).toBe(true);
    });

    it('fails when the substring is absent', async () => {
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
    const started = Date.now();

    const r = await retrying.executeAction(
      { type: 'assert', kind: 'text_visible', target: 'Nope' },
      page,
    );

    expect(r.success).toBe(false);
    // Four attempts at a 500ms wait would exceed 1.5s; one attempt stays well under.
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
