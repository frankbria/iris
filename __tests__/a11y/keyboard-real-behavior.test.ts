/**
 * Real-browser behavioural tests for keyboard + ARIA checks (issue #73).
 *
 * These deliberately use a real Chromium page rather than a mocked one. The bug
 * being fixed was that the checks reported `success: true` without observing the
 * page at all, so a mocked page cannot distinguish a fixed implementation from
 * the broken one. Each capability is asserted twice — once on markup that
 * genuinely behaves, once on markup that does not — because only the failing
 * case proves the check is real.
 */

import { chromium, Browser, Page } from 'playwright';
import { KeyboardTester } from '../../src/a11y/keyboard-tester';
import { AccessibilityRunner } from '../../src/a11y/a11y-runner';

// axe is not under test here; these cases target the keyboard/ARIA checks.
jest.mock('@axe-core/playwright', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    withTags: jest.fn().mockReturnThis(),
    withRules: jest.fn().mockReturnThis(),
    disableRules: jest.fn().mockReturnThis(),
    include: jest.fn().mockReturnThis(),
    exclude: jest.fn().mockReturnThis(),
    options: jest.fn().mockReturnThis(),
    analyze: jest.fn().mockResolvedValue({
      violations: [],
      passes: [],
      incomplete: [],
      inapplicable: [],
      testEngine: { name: 'axe-core', version: '4.8.0' },
    }),
  })),
}));

const config = {
  testFocusOrder: false,
  testTrapDetection: false,
  testArrowKeyNavigation: false,
  testEscapeHandling: false,
  customSequences: [],
};

/** data: URLs truncate at the first '#', which inline styles and hrefs contain. */
const load = (page: Page, html: string) =>
  page.goto('data:text/html;charset=utf-8,' + encodeURIComponent(html));

describe('keyboard + ARIA checks observe real behaviour (issue #73)', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
  }, 60000);

  afterAll(async () => {
    await browser?.close();
  });

  beforeEach(async () => {
    // axe/AxeBuilder requires a context-created page; keep the same shape here.
    page = await (await browser.newContext()).newPage();
  });

  afterEach(async () => {
    await page?.close();
  });

  describe('arrow key navigation', () => {
    // A roving-tabindex menu that genuinely moves focus on ArrowDown.
    const WORKING_MENU = `<!doctype html><html lang="en"><head><title>t</title></head><body>
      <ul id="menu" role="menu">
        <li role="menuitem" tabindex="0" id="i1">One</li>
        <li role="menuitem" tabindex="-1" id="i2">Two</li>
      </ul>
      <script>
        const items = [...document.querySelectorAll('[role=menuitem]')];
        document.getElementById('menu').addEventListener('keydown', (e) => {
          if (e.key !== 'ArrowDown') return;
          const i = items.indexOf(document.activeElement);
          items[Math.min(i + 1, items.length - 1)].focus();
        });
        items[0].focus();
      </script></body></html>`;

    // Same markup, no key handler at all — focus cannot move.
    const INERT_MENU = `<!doctype html><html lang="en"><head><title>t</title></head><body>
      <ul id="menu" role="menu">
        <li role="menuitem" tabindex="0" id="i1">One</li>
        <li role="menuitem" tabindex="-1" id="i2">Two</li>
      </ul></body></html>`;

    it('succeeds when ArrowDown actually moves focus', async () => {
      await load(page, WORKING_MENU);
      const result = await new KeyboardTester({
        ...config,
        testArrowKeyNavigation: true,
      }).run(page, 'menu');

      const arrow = result.interactions.filter((i) => i.key === 'ArrowDown');
      expect(arrow.length).toBeGreaterThan(0);
      expect(arrow.every((i) => i.success)).toBe(true);
      expect(result.passed).toBe(true);
    });

    // The core regression: this previously reported success unconditionally.
    it('fails when the menu ignores ArrowDown', async () => {
      await load(page, INERT_MENU);
      const result = await new KeyboardTester({
        ...config,
        testArrowKeyNavigation: true,
      }).run(page, 'menu');

      const arrow = result.interactions.filter((i) => i.key === 'ArrowDown');
      expect(arrow.length).toBeGreaterThan(0);
      expect(arrow.every((i) => i.success)).toBe(false);
      expect(result.passed).toBe(false);
    });
  });

  describe('focus trap detection', () => {
    // Tab from the last focusable wraps back inside — a genuine trap.
    const REAL_TRAP = `<!doctype html><html lang="en"><head><title>t</title></head><body>
      <div role="dialog" id="dlg" aria-modal="true">
        <button id="first">First</button><button id="last">Last</button>
      </div>
      <button id="outside">Outside</button>
      <script>
        const dlg = document.getElementById('dlg');
        const f = document.getElementById('first'), l = document.getElementById('last');
        dlg.addEventListener('keydown', (e) => {
          if (e.key === 'Tab' && !e.shiftKey && document.activeElement === l) {
            e.preventDefault(); f.focus();
          }
          if (e.key === 'Escape') dlg.style.display = 'none';
        });
      </script></body></html>`;

    // Looks like a dialog, but Tab escapes to the outside button.
    const LEAKY_TRAP = `<!doctype html><html lang="en"><head><title>t</title></head><body>
      <div role="dialog" id="dlg" aria-modal="true">
        <button id="first">First</button><button id="last">Last</button>
      </div>
      <button id="outside">Outside</button></body></html>`;

    it('reports trapped=true when Tab really stays inside', async () => {
      await load(page, REAL_TRAP);
      const result = await new KeyboardTester({
        ...config,
        testTrapDetection: true,
      }).run(page, 'dlg');

      expect(result.trapTests).toHaveLength(1);
      expect(result.trapTests[0].trapped).toBe(true);
    });

    // Previously every dialog-ish container was reported trapped from markup alone.
    it('reports trapped=false when Tab escapes the container', async () => {
      await load(page, LEAKY_TRAP);
      const result = await new KeyboardTester({
        ...config,
        testTrapDetection: true,
      }).run(page, 'dlg');

      expect(result.trapTests).toHaveLength(1);
      expect(result.trapTests[0].trapped).toBe(false);
    });

    it('records escapeMethod only when Escape actually dismisses the dialog', async () => {
      await load(page, REAL_TRAP);
      const withEscape = await new KeyboardTester({
        ...config,
        testTrapDetection: true,
      }).run(page, 'dlg');
      expect(withEscape.trapTests[0].escapeMethod).toBe('Escape');

      await load(page, LEAKY_TRAP);
      const withoutEscape = await new KeyboardTester({
        ...config,
        testTrapDetection: true,
      }).run(page, 'dlg');
      // No Escape handler and no close control — must not be guessed from markup.
      expect(withoutEscape.trapTests[0].escapeMethod).toBeUndefined();
    });
  });

  // offsetParent is null for position:fixed elements, so a fixed modal used to be
  // treated as invisible, skipped, and silently pass Escape handling.
  describe('escape handling on a position:fixed modal', () => {
    const FIXED_MODAL = (withEscapeHandler: boolean) =>
      `<!doctype html><html lang="en"><head><title>t</title>
       <style>#dlg{position:fixed;top:0;left:0;width:200px;height:100px}</style></head><body>
        <div role="dialog" id="dlg" aria-modal="true"><button id="b">Ok</button></div>
        ${
          withEscapeHandler
            ? `<script>document.addEventListener('keydown',e=>{
                 if(e.key==='Escape') document.getElementById('dlg').style.display='none';});</script>`
            : ''
        }
       </body></html>`;

    it('fails a fixed modal that ignores Escape instead of skipping it', async () => {
      await load(page, FIXED_MODAL(false));
      const result = await new KeyboardTester({
        ...config,
        testEscapeHandling: true,
      }).run(page, 'dlg');

      const escape = result.interactions.filter((i) => i.key === 'Escape');
      expect(escape).toHaveLength(1); // previously 0 — the modal was skipped
      expect(escape[0].success).toBe(false);
      expect(result.passed).toBe(false);
    });

    it('passes a fixed modal that does handle Escape', async () => {
      await load(page, FIXED_MODAL(true));
      const result = await new KeyboardTester({
        ...config,
        testEscapeHandling: true,
      }).run(page, 'dlg');

      const escape = result.interactions.filter((i) => i.key === 'Escape');
      expect(escape).toHaveLength(1);
      expect(escape[0].success).toBe(true);
      expect(result.passed).toBe(true);
    });
  });

  // The ARIA announcements were collected, stamped success:true, and then left
  // out of the verdict entirely.
  describe('ARIA announcement validation', () => {
    const runScreenReader = async (html: string) => {
      // Serve the fixture from a data: URL via the runner's own page handling.
      const runner = new AccessibilityRunner({
        pages: ['data:text/html;charset=utf-8,' + encodeURIComponent(html)],
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
          testAriaLabels: true,
          testLandmarkNavigation: false,
          testImageAltText: false,
          testHeadingStructure: false,
          simulateScreenReader: true,
        },
        failureThreshold: {},
        reporting: { includePassedTests: false, groupByImpact: true, includeScreenshots: false },
      });
      const result = await runner.run();
      return result.results[0].screenReaderResult!;
    };

    it('accepts a well-formed aria-label and a resolvable aria-labelledby', async () => {
      const sr = await runScreenReader(
        `<!doctype html><html lang="en"><head><title>t</title></head><body>
           <button aria-label="Close dialog">X</button>
           <span id="lbl">Search</span>
           <input aria-labelledby="lbl">
         </body></html>`,
      );

      expect(sr.announcements).toHaveLength(2);
      expect(sr.announcements.every((a) => a.success)).toBe(true);
      expect(sr.passed).toBe(true);
    });

    it('fails an empty aria-label and reports why', async () => {
      const sr = await runScreenReader(
        `<!doctype html><html lang="en"><head><title>t</title></head><body>
           <button aria-label="  ">X</button>
         </body></html>`,
      );

      expect(sr.announcements[0].success).toBe(false);
      expect(sr.announcements[0].actualText).toContain('aria-label is empty');
      expect(sr.passed).toBe(false);
    });

    it('fails an aria-labelledby pointing at a missing id', async () => {
      const sr = await runScreenReader(
        `<!doctype html><html lang="en"><head><title>t</title></head><body>
           <input aria-labelledby="does-not-exist">
         </body></html>`,
      );

      expect(sr.announcements[0].success).toBe(false);
      expect(sr.announcements[0].actualText).toContain('missing id "does-not-exist"');
      expect(sr.passed).toBe(false);
    });

    it('fails an aria-labelledby whose target has no text', async () => {
      const sr = await runScreenReader(
        `<!doctype html><html lang="en"><head><title>t</title></head><body>
           <span id="blank"></span>
           <input aria-labelledby="blank">
         </body></html>`,
      );

      expect(sr.announcements[0].success).toBe(false);
      expect(sr.announcements[0].actualText).toContain('has no text');
      expect(sr.passed).toBe(false);
    });

    // aria-describedby supplements a name rather than providing it, so a
    // text-free target is acceptable; only a dangling reference is a defect.
    it('accepts an aria-describedby target without text but rejects a dangling one', async () => {
      const ok = await runScreenReader(
        `<!doctype html><html lang="en"><head><title>t</title></head><body>
           <span id="d"></span><input aria-describedby="d">
         </body></html>`,
      );
      expect(ok.announcements[0].success).toBe(true);

      const dangling = await runScreenReader(
        `<!doctype html><html lang="en"><head><title>t</title></head><body>
           <input aria-describedby="nope">
         </body></html>`,
      );
      expect(dangling.announcements[0].success).toBe(false);
    });
  });
});
