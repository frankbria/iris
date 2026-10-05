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

    // A roving-tabindex menu whose container is NOT focusable and which does not
    // pre-focus anything. page.focus() is a silent no-op here, so without the
    // focus fallback the key press never reaches the handler and this working
    // menu would false-fail.
    const WORKING_MENU_NO_PREFOCUS = `<!doctype html><html lang="en"><head><title>t</title></head><body>
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
      </script></body></html>`;

    it('succeeds on a working menu that does not pre-focus an item', async () => {
      await load(page, WORKING_MENU_NO_PREFOCUS);
      const result = await new KeyboardTester({
        ...config,
        testArrowKeyNavigation: true,
      }).run(page, 'menu');

      const arrow = result.interactions.filter((i) => i.key === 'ArrowDown');
      expect(arrow.length).toBeGreaterThan(0);
      expect(arrow.every((i) => i.success)).toBe(true);
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

  // #285: elements were addressed by `TAG#id` / `TAG.firstClass`. Radix ids contain colons,
  // Tailwind classes contain `:` and `[`, an id-less class-less element gave `UL.`: all
  // invalid selectors, so working widgets failed. An SVG <a> (className is not a string)
  // threw and aborted the whole run.
  describe('elements whose ids and classes make poor selectors (#285)', () => {
    it('tests a Radix-style dialog whose id and classes are not valid selectors', async () => {
      await load(
        page,
        `<!doctype html><html lang="en"><head><title>t</title></head><body>
        <div role="dialog" id="radix-:r1:" data-state="open" aria-modal="true"
             class="md:w-[400px] fixed">
          <button>Close</button>
        </div>
        <script>document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') document.getElementById('radix-:r1:').remove();
        });</script></body></html>`,
      );
      const result = await new KeyboardTester({ ...config, testEscapeHandling: true }).run(
        page,
        'radix',
      );
      const escape = result.interactions.filter((i) => i.key === 'Escape');
      expect(escape).toHaveLength(1);
      expect(escape[0]).toMatchObject({ success: true, actualBehavior: 'Closed' });
      expect(escape[0].target).toContain('radix-:r1:'); // readable, not a marker
    });

    it('tests each id-less, class-less menu on its own', async () => {
      // Two menus with nothing to tell them apart by tag, id or class. The first ignores
      // ArrowDown, the second handles it: each verdict must be about its own menu.
      const menu = (handler: boolean) => `<ul role="menu">
          <li role="menuitem" tabindex="0">One</li><li role="menuitem" tabindex="-1">Two</li>
        </ul>${
          handler
            ? `<script>{const m=document.querySelectorAll('[role=menu]')[1];
                const items=[...m.querySelectorAll('[role=menuitem]')];
                m.addEventListener('keydown',(e)=>{ if(e.key!=='ArrowDown')return;
                  items[Math.min(items.indexOf(document.activeElement)+1,items.length-1)].focus();});}</script>`
            : ''
        }`;
      await load(
        page,
        `<!doctype html><html lang="en"><head><title>t</title></head><body>${menu(false)}${menu(true)}</body></html>`,
      );
      const result = await new KeyboardTester({ ...config, testArrowKeyNavigation: true }).run(
        page,
        'menus',
      );
      const arrow = result.interactions.filter((i) => i.key === 'ArrowDown');
      expect(arrow.map((i) => i.success)).toEqual([false, true]);
      // The markers used to address them are removed afterwards.
      expect(
        await page.evaluate(() =>
          [...document.querySelectorAll('*')].some((el) =>
            el.getAttributeNames().some((n) => n.startsWith('data-iris-kbd')),
          ),
        ),
      ).toBe(false);
    });

    // A handler that replaces the dialog node (a re-render) and leaves it open drops our
    // marker; that is not a dismissal.
    it('fails a dialog that Escape replaces but leaves open', async () => {
      await load(
        page,
        `<!doctype html><html lang="en"><head><title>t</title></head><body>
        <div id="host"><div role="dialog" aria-modal="true"><button>Ok</button></div></div>
        <script>document.addEventListener('keydown', (e) => {
          if (e.key !== 'Escape') return;
          document.getElementById('host').innerHTML =
            '<div role="dialog" aria-modal="true"><button>Ok</button></div>';
        });</script></body></html>`,
      );
      const result = await new KeyboardTester({ ...config, testEscapeHandling: true }).run(
        page,
        'rerender',
      );
      const escape = result.interactions.filter((i) => i.key === 'Escape');
      expect(escape).toHaveLength(1);
      expect(escape[0]).toMatchObject({ success: false, actualBehavior: 'Still visible' });
    });

    // A <form>'s named controls shadow its methods: `form.setAttribute` is the input.
    it('does not abort on a dialog whose controls shadow its methods', async () => {
      await load(
        page,
        `<!doctype html><html lang="en"><head><title>t</title></head><body>
        <form role="dialog" aria-modal="true" id="f" class="sheet">
          <input name="setAttribute"><input name="getAttribute"><input name="id">
        </form></body></html>`,
      );
      const result = await new KeyboardTester({
        ...config,
        testEscapeHandling: true,
        testFocusOrder: true,
      }).run(page, 'clobber');
      const escape = result.interactions.filter((i) => i.key === 'Escape');
      expect(escape).toHaveLength(1);
      expect(escape[0].target).toBe('FORM#f.sheet');
    });

    it("leaves the page's own data-iris-trap attribute alone and judges our container", async () => {
      // A decoy ahead of the dialog with the value our first trap marker would have had.
      await load(
        page,
        `<!doctype html><html lang="en"><head><title>t</title></head><body>
        <div data-iris-trap="0"><a href="#x">decoy</a></div>
        <div role="dialog" aria-modal="true"><button id="only">Only</button></div>
        <script>document.addEventListener('keydown', (e) => {
          if (e.key === 'Tab') { e.preventDefault(); document.getElementById('only').focus(); }
        });</script></body></html>`,
      );
      const result = await new KeyboardTester({ ...config, testTrapDetection: true }).run(
        page,
        'trap-decoy',
      );
      expect(result.trapTests).toEqual([expect.objectContaining({ trapped: true })]);
      expect(await page.locator('[data-iris-trap="0"]').count()).toBe(1);
    });

    it("never mistakes the page's own data-iris-kbd attribute for a marker", async () => {
      // The page's element comes first in document order with the value our first marker
      // would have had without a per-run nonce; it ignores ArrowDown.
      await load(
        page,
        `<!doctype html><html lang="en"><head><title>t</title></head><body>
        <div data-iris-kbd="arrow-0" tabindex="0">decoy</div>
        <ul role="menu" data-iris-kbd="mine"><li role="menuitem" tabindex="0">One</li><li role="menuitem" tabindex="-1">Two</li></ul>
        <script>{const m=document.querySelector('[role=menu]');
          const items=[...m.querySelectorAll('[role=menuitem]')];
          m.addEventListener('keydown',(e)=>{ if(e.key!=='ArrowDown')return;
            items[Math.min(items.indexOf(document.activeElement)+1,items.length-1)].focus();});}</script>
        </body></html>`,
      );
      const result = await new KeyboardTester({ ...config, testArrowKeyNavigation: true }).run(
        page,
        'decoy',
      );
      expect(
        result.interactions.filter((i) => i.key === 'ArrowDown').map((i) => i.success),
      ).toEqual([true]);
      // The page's own attributes are left alone, including the one on the tested menu.
      expect(await page.locator('[data-iris-kbd="arrow-0"]').count()).toBe(1);
      expect(await page.locator('[role=menu][data-iris-kbd="mine"]').count()).toBe(1);
    });

    // One Escape closes a .modal wrapper and its inner [role=dialog] together: the inner
    // candidate is gone before its own turn, which is not a failure.
    // Codex's case: Escape swaps the wrapper for a bare, still-open dialog with the same id.
    // The page-wide count drops (2 -> 1), but the dialog with that id is still open.
    it('fails an id-ed dialog that a re-render leaves open, though the count dropped', async () => {
      await load(
        page,
        `<!doctype html><html lang="en"><head><title>t</title></head><body>
        <div id="host"><div class="modal"><div role="dialog" id="d"><button>Ok</button></div></div></div>
        <script>document.addEventListener('keydown', (e) => {
          if (e.key !== 'Escape') return;
          document.getElementById('host').innerHTML = '<div role="dialog" id="d"><button>Ok</button></div>';
        });</script></body></html>`,
      );
      const result = await new KeyboardTester({ ...config, testEscapeHandling: true }).run(
        page,
        'rerender-id',
      );
      const dialog = result.interactions.find((i) => i.key === 'Escape' && i.target.includes('#d'));
      expect(dialog).toMatchObject({ success: false, actualBehavior: 'Still visible' });
      expect(result.passed).toBe(false);
    });

    // Codex: Escape closes the first dialog and re-renders the second (id-less) one, which
    // stays open. Its marker is gone before its turn; tag + class still identify it.
    it('tests an id-less dialog that an earlier Escape re-rendered but left open', async () => {
      await load(
        page,
        `<!doctype html><html lang="en"><head><title>t</title></head><body>
        <div role="dialog" class="sheet a" id="a"><button>A</button></div>
        <div id="host"><div role="dialog" class="sheet b"><button>B</button></div></div>
        <script>document.addEventListener('keydown', (e) => {
          if (e.key !== 'Escape') return;
          document.getElementById('a')?.remove();
          document.getElementById('host').innerHTML =
            '<div role="dialog" class="sheet b"><button>B</button></div>';
        });</script></body></html>`,
      );
      const result = await new KeyboardTester({ ...config, testEscapeHandling: true }).run(
        page,
        'rerender-b',
      );
      const escape = result.interactions.filter((i) => i.key === 'Escape');
      expect(escape.map((i) => i.success)).toEqual([true, false]); // A closed, B ignored it
      expect(result.passed).toBe(false);
    });

    it('does not fail a dialog that an earlier Escape already closed', async () => {
      await load(
        page,
        `<!doctype html><html lang="en"><head><title>t</title></head><body>
        <div class="modal" id="wrap"><div role="dialog" aria-modal="true"><button>Ok</button></div></div>
        <script>document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') document.getElementById('wrap')?.remove();
        });</script></body></html>`,
      );
      const result = await new KeyboardTester({ ...config, testEscapeHandling: true }).run(
        page,
        'nested',
      );
      const escape = result.interactions.filter((i) => i.key === 'Escape');
      expect(escape.map((i) => i.success)).toEqual([true]);
      expect(result.passed).toBe(true);
    });

    it('does not abort on clobbered menus or trap containers, and cleans up', async () => {
      await load(
        page,
        `<!doctype html><html lang="en"><head><title>t</title></head><body>
        <form role="menu"><input name="getAttribute"><input name="querySelector"><input name="contains"></form>
        <form role="dialog" aria-modal="true">
          <input name="removeAttribute"><input name="querySelectorAll"><button>Ok</button>
        </form></body></html>`,
      );
      const result = await new KeyboardTester({
        ...config,
        testArrowKeyNavigation: true,
        testTrapDetection: true,
      }).run(page, 'clobbered');
      expect(result.interactions.filter((i) => i.key === 'ArrowDown')).toHaveLength(1);
      // Our per-run trap marker (data-iris-trap-<nonce>) is gone again.
      expect(
        await page.evaluate(() =>
          [...document.querySelectorAll('*')].some((el) =>
            el.getAttributeNames().some((n) => n.startsWith('data-iris-trap')),
          ),
        ),
      ).toBe(false);
    });

    it('does not crash on an SVG link', async () => {
      await load(
        page,
        `<!doctype html><html lang="en"><head><title>t</title></head><body>
        <svg width="100" height="40" class="icon"><a href="/next" class="svg-link">
          <text x="0" y="20">Next</text></a></svg>
        <a href="/plain">Plain</a></body></html>`,
      );
      const result = await new KeyboardTester({ ...config, testFocusOrder: true }).run(page, 'svg');
      // Both links, labelled by tag first (an SVG element's tagName is lowercase).
      expect(result.focusOrder.map((f) => f.element.split(/[#.]/)[0].toUpperCase())).toEqual([
        'A',
        'A',
      ]);
      expect(result.focusOrder[0].element).toContain('svg-link');
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

    // Consistent with the rule above: describedby does not supply the accessible
    // name, so a blank one is untidy rather than broken. A blank labelledby DOES
    // leave the element nameless and must fail.
    it('tolerates an empty aria-describedby but not an empty aria-labelledby', async () => {
      const described = await runScreenReader(
        `<!doctype html><html lang="en"><head><title>t</title></head><body>
           <input aria-describedby="  ">
         </body></html>`,
      );
      expect(described.announcements[0].success).toBe(true);

      const labelled = await runScreenReader(
        `<!doctype html><html lang="en"><head><title>t</title></head><body>
           <input aria-labelledby="  ">
         </body></html>`,
      );
      expect(labelled.announcements[0].success).toBe(false);
      expect(labelled.announcements[0].actualText).toContain('aria-labelledby is empty');
    });
  });
});
