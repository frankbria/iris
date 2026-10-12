/**
 * Freezing animations keeps static transforms (#323): `transform: none` in the freeze
 * stylesheet un-rotated every element, so a screenshot showed a layout the page never has.
 *
 * Test strategy: real Chromium through the launch factory. A rotated element must stay
 * rotated after the capture engine disables animations, while an element mid-transition
 * is frozen at its end state (the transition is gone).
 */

import type { Browser, Page } from 'playwright';
import { launchBrowser } from '../../src/browser';
import { VisualCaptureEngine } from '../../src/visual/capture';

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
});
beforeEach(async () => {
  page = await browser.newPage();
  await page.setContent(`<!doctype html><title>t</title>
    <div id="rotated" style="width:80px;height:20px;background:#333;transform:rotate(45deg)"></div>
    <div id="moving" style="width:80px;height:20px;background:#666;transition:opacity 60s;opacity:1"></div>`);
});
afterEach(async () => {
  await page?.close();
});

// A string, not a function: under --coverage a function sent to the page fails.
const style = (id: string, prop: string) =>
  page.evaluate(
    `getComputedStyle(document.getElementById(${JSON.stringify(id)}))[${JSON.stringify(prop)}]`,
  );

it('keeps a rotated element rotated when animations are disabled', async () => {
  const before = await style('rotated', 'transform');
  expect(before).not.toBe('none');
  const shot = await new VisualCaptureEngine().capture(page, {
    fullPage: false,
    maskSelectors: [],
    stabilizeMs: 0,
    disableAnimations: true,
    type: 'png',
  });
  expect(shot.success).toBe(true);
  expect(await style('rotated', 'transform')).toBe(before);
});

it('still freezes transitions', async () => {
  await new VisualCaptureEngine().capture(page, {
    fullPage: false,
    maskSelectors: [],
    stabilizeMs: 0,
    disableAnimations: true,
    type: 'png',
  });
  expect(await style('moving', 'transitionDuration')).toBe('0s');
});
