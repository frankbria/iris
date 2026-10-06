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
import http from 'http';
import type { AddressInfo } from 'net';
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

  // #286: focus order was a static selector scan that failed any negative tabindex (the
  // roving-tabindex pattern) and never pressed Tab; Escape was tested after the trap test
  // had already pressed Escape on every dialog.
  describe('focus order from real Tab presses (#286)', () => {
    it('passes a roving-tabindex toolbar', async () => {
      await load(
        page,
        `<!doctype html><html lang="en"><head><title>t</title></head><body>
        <div role="toolbar" aria-label="Format">
          <button tabindex="0">Bold</button><button tabindex="-1">Italic</button>
          <button tabindex="-1">Underline</button>
        </div><a href="#next">Next</a></body></html>`,
      );
      const result = await new KeyboardTester({ ...config, testFocusOrder: true }).run(
        page,
        'roving',
      );
      expect(result.focusOrder.map((f) => f.element)).toEqual(['BUTTON', 'A']);
      expect(result.passed).toBe(true);
    });

    it('fails a positive tabindex, and reports the order Tab really takes', async () => {
      await load(
        page,
        `<!doctype html><html lang="en"><head><title>t</title></head><body>
        <button id="one">One</button><button id="jump" tabindex="2">Jumps the queue</button>
        </body></html>`,
      );
      const result = await new KeyboardTester({ ...config, testFocusOrder: true }).run(
        page,
        'positive',
      );
      expect(result.focusOrder.map((f) => f.element)).toEqual(['BUTTON#jump', 'BUTTON#one']);
      expect(result.passed).toBe(false);
    });

    it('fails when Tab moves focus onto something invisible', async () => {
      await load(
        page,
        `<!doctype html><html lang="en"><head><title>t</title></head><body>
        <a href="#a">Visible</a>
        <a href="#b" id="ghost" style="opacity:0;position:absolute;width:0;height:0;overflow:hidden">Ghost</a>
        </body></html>`,
      );
      const result = await new KeyboardTester({ ...config, testFocusOrder: true }).run(
        page,
        'ghost',
      );
      expect(result.focusOrder.find((f) => f.element === 'A#ghost')?.visible).toBe(false);
      expect(result.passed).toBe(false);
    });
  });

  // Review of #286: where the walk starts and what it can see inside.
  describe('Tab walk boundaries (#286 review)', () => {
    const walk = async (html: string) => {
      await load(
        page,
        `<!doctype html><html lang="en"><head><title>t</title></head><body>${html}</body></html>`,
      );
      return new KeyboardTester({ ...config, testFocusOrder: true }).run(page, 'walk');
    };

    it('starts at the document start even when the page autofocused a later control', async () => {
      const result = await walk(
        '<a href="#1" id="first">1</a><a href="#2" id="second">2</a><input id="last" autofocus>',
      );
      expect(result.focusOrder.map((f) => f.element)).toEqual([
        'A#first',
        'A#second',
        'INPUT#last',
      ]);
    });

    it('reports the order from the top when the page autofocused a control mid-page', async () => {
      const result = await walk(
        '<a href="#1" id="a1">1</a><input id="mid" autofocus><a href="#3" id="a3">3</a><button tabindex="1" id="pos">P</button>',
      );
      // Positive tabindex first, then tree order, whatever the page focused at load.
      expect(result.focusOrder.map((f) => f.element)).toEqual([
        'BUTTON#pos',
        'A#a1',
        'INPUT#mid',
        'A#a3',
      ]);
      expect(result.passed).toBe(false); // the positive tabindex
    });

    it('records stops inside a shadow root and goes on past it', async () => {
      const result = await walk(`<div id="host"></div><a href="#after" id="after">after</a>
        <script>const r = document.getElementById('host').attachShadow({ mode: 'open' });
          r.innerHTML = '<button id="s1">S1</button><button id="s2">S2</button>';</script>`);
      expect(result.focusOrder.map((f) => f.element)).toEqual([
        'BUTTON#s1',
        'BUTTON#s2',
        'A#after',
      ]);
    });

    it('records stops inside a same-origin iframe and goes on past it', async () => {
      const result =
        await walk(`<iframe srcdoc="<button id=f1>F1</button><button id=f2>F2</button>"></iframe>
        <a href="#after" id="after">after</a>`);
      await page.waitForTimeout(0);
      expect(result.focusOrder.map((f) => f.element)).toEqual([
        'BUTTON#f1',
        'BUTTON#f2',
        'A#after',
      ]);
    });

    it('treats a stop inside an invisible parent as invisible', async () => {
      const result = await walk(
        '<div style="opacity:0"><a href="#x" id="hidden-by-parent">x</a></div>',
      );
      expect(result.focusOrder).toEqual([
        expect.objectContaining({ element: 'A#hidden-by-parent', visible: false }),
      ]);
      expect(result.passed).toBe(false);
    });

    it('treats a control inside an invisible iframe as invisible', async () => {
      const result = await walk(
        `<iframe style="opacity:0" srcdoc="<button id=in>In</button>"></iframe>`,
      );
      await page.waitForTimeout(0);
      expect(result.focusOrder).toEqual([
        expect.objectContaining({ element: 'BUTTON#in', visible: false }),
      ]);
      expect(result.passed).toBe(false);
    });

    it('accepts a visible control inside a visibility:hidden container', async () => {
      const result = await walk(
        '<div style="visibility:hidden"><button id="shown" style="visibility:visible">Shown</button></div>',
      );
      expect(result.focusOrder).toEqual([
        expect.objectContaining({ element: 'BUTTON#shown', visible: true }),
      ]);
      expect(result.passed).toBe(true);
    });

    it('does not abort on a form that shadows getRootNode', async () => {
      const result = await walk('<form><input name="getRootNode"><button id="b">B</button></form>');
      expect(result.focusOrder.map((f) => f.element)).toEqual(['INPUT', 'BUTTON#b']);
    });

    it('presses through a closed shadow root and goes on past it', async () => {
      const result = await walk(`<div id="host"></div><a href="#after" id="after">after</a>
        <script>const r = document.getElementById('host').attachShadow({ mode: 'closed' });
          r.innerHTML = '<button>S1</button><button>S2</button>';</script>`);
      // The page cannot see inside: the host once, then what follows it.
      expect(result.focusOrder.map((f) => f.element)).toEqual(['DIV#host', 'A#after']);
    });

    it('does not abort when the page focused an SVG link on load', async () => {
      const result =
        await walk(`<svg width="40" height="20"><a href="#i" id="icon"><text y="15">i</text></a></svg>
        <a href="#next" id="next">next</a>
        <script>document.getElementById('icon').focus();</script>`);
      expect(result.focusOrder.map((f) => f.element.toUpperCase())).toEqual(['A#ICON', 'A#NEXT']);
    });

    it('tells apart controls of a form that shadows children and parentNode', async () => {
      const result =
        await walk(`<form><input name="children" id="c"><input name="parentElement" id="p">
        <input id="ghost" style="opacity:0"></form>`);
      expect(result.focusOrder.map((f) => f.element)).toEqual([
        'INPUT#c',
        'INPUT#p',
        'INPUT#ghost',
      ]);
      expect(result.passed).toBe(false); // the invisible one is reached and judged
    });

    // Codex P1: read directly, parentElement on such a form cycled input -> form -> input.
    it('does not hang the arrow check on a menu inside a form that shadows parentElement', async () => {
      await load(
        page,
        `<!doctype html><html lang="en"><head><title>t</title></head><body>
        <form><input name="parentElement"><ul role="menu"><li role="menuitem" tabindex="0">One</li>
        <li role="menuitem" tabindex="-1">Two</li></ul></form></body></html>`,
      );
      const result = await new KeyboardTester({ ...config, testArrowKeyNavigation: true }).run(
        page,
        'arrow-clobber',
      );
      expect(result.interactions.filter((i) => i.key === 'ArrowDown')).toHaveLength(1);
    }, 30_000);

    it("judges a stop inside a host by the host's positive tabindex", async () => {
      const result = await walk(`<a href="#a" id="a">a</a>
        <iframe tabindex="3" srcdoc="<button id=in>In</button>"></iframe>`);
      await page.waitForTimeout(0);
      expect(result.focusOrder.find((f) => f.element === 'BUTTON#in')?.tabIndex).toBe(3);
      expect(result.passed).toBe(false);
    });

    it('does not fail a closed shadow host with display: contents', async () => {
      const result = await walk(`<div id="host" style="display:contents"></div>
        <script>const r = document.getElementById('host').attachShadow({ mode: 'closed' });
          r.innerHTML = '<button>Inside</button>';</script>`);
      expect(result.focusOrder).toEqual([
        expect.objectContaining({ element: 'DIV#host', visible: true }),
      ]);
      expect(result.passed).toBe(true);
    });

    it('says so when the Tab order is longer than it walks', async () => {
      const links = Array.from({ length: 205 }, (_, i) => `<a href="#l${i}">${i}</a>`).join('');
      const result = await walk(links);
      expect(result.focusOrder).toHaveLength(200);
      expect(result.interactions).toEqual([
        expect.objectContaining({
          actualBehavior: 'Stopped after 200 stops: the walk did not finish',
          success: true,
        }),
      ]);
    }, 60_000);
  });

  describe('Escape is tested on its own, after the trap test (#286)', () => {
    const DIALOG = (closes: boolean) =>
      `<!doctype html><html lang="en"><head><title>t</title></head><body>
       <div role="dialog" aria-modal="true" id="d"><button>Ok</button></div>
       ${
         closes
           ? `<script>document.addEventListener('keydown',(e)=>{
                if(e.key==='Escape') document.getElementById('d').remove();});</script>`
           : ''
       }</body></html>`;

    it('records Escape for a dialog the trap test already closed with Escape', async () => {
      await load(page, DIALOG(true));
      const result = await new KeyboardTester({
        ...config,
        testTrapDetection: true,
        testEscapeHandling: true,
      }).run(page, 'escape-after-trap');
      const escape = result.interactions.filter((i) => i.key === 'Escape');
      expect(escape).toEqual([expect.objectContaining({ target: 'DIV#d', success: true })]);
    });

    it('passes a dialog whose own Escape handler needs focus inside it', async () => {
      await load(
        page,
        `<!doctype html><html lang="en"><head><title>t</title></head><body>
        <div role="dialog" aria-modal="true" id="d">
          <button style="display:none">Hidden</button><button>Ok</button>
        </div>
        <script>document.getElementById('d').addEventListener('keydown', (e) => {
          if (e.key === 'Escape') e.currentTarget.remove();
        });</script></body></html>`,
      );
      const result = await new KeyboardTester({
        ...config,
        testTrapDetection: true,
        testEscapeHandling: true,
      }).run(page, 'dialog-handler');
      const escape = result.interactions.filter((i) => i.key === 'Escape');
      expect(escape).toEqual([expect.objectContaining({ target: 'DIV#d', success: true })]);
    });

    it('focuses past an SVG link at the start of the dialog', async () => {
      await load(
        page,
        `<!doctype html><html lang="en"><head><title>t</title></head><body>
        <div role="dialog" aria-modal="true" id="d">
          <svg width="40" height="20"><a href="#icon"><text y="15">i</text></a></svg><button>Ok</button>
        </div>
        <script>document.getElementById('d').addEventListener('keydown', (e) => {
          if (e.key === 'Escape') e.currentTarget.remove();
        });</script></body></html>`,
      );
      const result = await new KeyboardTester({
        ...config,
        testTrapDetection: true,
        testEscapeHandling: true,
      }).run(page, 'svg-first');
      const escape = result.interactions.filter((i) => i.key === 'Escape');
      expect(escape).toEqual([expect.objectContaining({ target: 'DIV#d', success: true })]);
    });

    // A dialog opened by script after load is not brought back by the reload: say so,
    // never pass it silently.
    it('reports a dialog the reload could not bring back', async () => {
      await load(
        page,
        '<!doctype html><html lang="en"><head><title>t</title></head><body></body></html>',
      );
      await page.evaluate(() => {
        document.body.insertAdjacentHTML(
          'beforeend',
          '<div role="dialog" aria-modal="true" id="late"><button>Ok</button></div>',
        );
      });
      const result = await new KeyboardTester({
        ...config,
        testTrapDetection: true,
        testEscapeHandling: true,
      }).run(page, 'late-dialog');
      expect(result.interactions).toContainEqual(
        expect.objectContaining({
          success: false,
          actualBehavior: 'Reloading brought back 0 of 1 dialog(s); the rest could not be tested',
        }),
      );
      expect(result.passed).toBe(false);
    });

    // GLM: the dialog count is taken on the page as loaded, before the Tab walk, which may
    // itself open a dialog (one shown on focus).
    it('does not count a dialog the Tab walk opened as lost by the reload', async () => {
      await load(
        page,
        `<!doctype html><html lang="en"><head><title>t</title></head><body>
        <input id="search" aria-label="Search">
        <script>document.getElementById('search').addEventListener('focus', () => {
          if (!document.getElementById('panel')) document.body.insertAdjacentHTML('beforeend',
            '<div role="dialog" id="panel"><button>Close</button></div>');
        });</script></body></html>`,
      );
      const result = await new KeyboardTester({
        ...config,
        testFocusOrder: true,
        testTrapDetection: true,
        testEscapeHandling: true,
      }).run(page, 'focus-opens-dialog');
      expect(result.interactions.map((i) => i.actualBehavior)).not.toContainEqual(
        expect.stringMatching(/Reloading brought back/),
      );
    });

    // GLM: a dialog that mounts after a fetch is counted on the settled page; the reload
    // must settle too before it is compared.
    it('waits for a dialog that mounts after a fetch before comparing', async () => {
      const server = http.createServer((req, res) => {
        if (req.url === '/data') {
          setTimeout(() => res.end('{}'), 300);
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html><html lang="en"><head><title>t</title></head><body>
          <script>fetch('/data').then(() => document.body.insertAdjacentHTML('beforeend',
            '<div role="dialog" id="late"><button>Ok</button></div>'));</script></body></html>`);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, {
          waitUntil: 'networkidle',
        });
        const result = await new KeyboardTester({
          ...config,
          testTrapDetection: true,
          testEscapeHandling: true,
        }).run(page, 'fetch-dialog');
        expect(result.interactions.map((i) => i.actualBehavior)).not.toContainEqual(
          expect.stringMatching(/Reloading brought back/),
        );
        expect(result.interactions.filter((i) => i.key === 'Escape')).toHaveLength(1);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it('focuses an SVG dialog with nothing focusable inside', async () => {
      await load(
        page,
        `<!doctype html><html lang="en"><head><title>t</title></head><body>
        <svg role="dialog" aria-modal="true" id="d" width="60" height="30"><text y="20">Hi</text></svg>
        <script>document.getElementById('d').addEventListener('keydown', (e) => {
          if (e.key === 'Escape') e.currentTarget.remove();
        });</script></body></html>`,
      );
      const result = await new KeyboardTester({ ...config, testEscapeHandling: true }).run(
        page,
        'svg-dialog',
      );
      const escape = result.interactions.filter((i) => i.key === 'Escape');
      expect(escape).toEqual([expect.objectContaining({ success: true })]);
    });

    // GLM: a dialog whose Escape handler navigates left the trap check on another page, and
    // the reload then reloaded that page instead of the one under test.
    it('returns to the page under test when the trap check navigated away', async () => {
      const html = `<!doctype html><html lang="en"><head><title>t</title></head><body>
        <div role="dialog" aria-modal="true" id="d"><button>Ok</button></div>
        <script>document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') location.href = 'about:blank';
        });</script></body></html>`;
      await load(page, html);
      const result = await new KeyboardTester({
        ...config,
        testTrapDetection: true,
        testEscapeHandling: true,
      }).run(page, 'navigating-escape');
      expect(result.interactions.map((i) => i.actualBehavior)).not.toContainEqual(
        expect.stringMatching(/Reloading brought back/),
      );
      expect(result.interactions.filter((i) => i.key === 'Escape')).toEqual([
        expect.objectContaining({ target: 'DIV#d', success: true }),
      ]);
    });

    it('still fails a dialog that ignores Escape', async () => {
      await load(page, DIALOG(false));
      const result = await new KeyboardTester({
        ...config,
        testTrapDetection: true,
        testEscapeHandling: true,
      }).run(page, 'escape-ignored');
      const escape = result.interactions.filter((i) => i.key === 'Escape');
      expect(escape).toEqual([expect.objectContaining({ success: false })]);
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

    // Codex: the re-render changes the class list (`sheet` -> `sheet shaking`) and leaves the
    // dialog open. No exact match is unknown, not dismissed; the visible count decides.
    it('fails an id-less dialog that a re-render reclassed but left open', async () => {
      await load(
        page,
        `<!doctype html><html lang="en"><head><title>t</title></head><body>
        <div id="host"><div role="dialog" class="sheet"><button>Ok</button></div></div>
        <script>document.addEventListener('keydown', (e) => {
          if (e.key !== 'Escape') return;
          document.getElementById('host').innerHTML =
            '<div role="dialog" class="sheet shaking"><button>Ok</button></div>';
        });</script></body></html>`,
      );
      const result = await new KeyboardTester({ ...config, testEscapeHandling: true }).run(
        page,
        'reclassed',
      );
      const escape = result.interactions.filter((i) => i.key === 'Escape');
      expect(escape).toEqual([
        expect.objectContaining({ success: false, actualBehavior: 'Still visible' }),
      ]);
    });

    // GLM: a .modal wrapper and its id-less inner panel close together beside a persistent
    // dialog that ignores Escape. The panel is gone before its turn and must not be blamed:
    // only the chat dialog fails.
    it('does not blame a dialog that closed with its wrapper while another stays open', async () => {
      await load(
        page,
        `<!doctype html><html lang="en"><head><title>t</title></head><body>
        <div class="modal" id="wrap"><div role="dialog" class="panel"><button>Ok</button></div></div>
        <div role="dialog" id="chat"><button>Chat</button></div>
        <script>document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') document.getElementById('wrap')?.remove();
        });</script></body></html>`,
      );
      const result = await new KeyboardTester({ ...config, testEscapeHandling: true }).run(
        page,
        'wrapper-and-chat',
      );
      const escape = result.interactions.filter((i) => i.key === 'Escape');
      expect(escape.map((i) => [i.target.split('.')[0], i.success])).toEqual([
        ['DIV#wrap', true],
        ['DIV#chat', false],
      ]);
    });

    // Codex: the open dialog is re-rendered with other classes and a hidden template keeps
    // the original classes. A class match may never establish dismissal.
    it('does not take a hidden template with the old classes for a dismissal', async () => {
      await load(
        page,
        `<!doctype html><html lang="en"><head><title>t</title></head><body>
        <div id="host"><div role="dialog" class="sheet shaking"><button>Ok</button></div></div>
        <script>document.addEventListener('keydown', (e) => {
          if (e.key !== 'Escape') return;
          document.getElementById('host').innerHTML =
            '<div role="dialog" class="sheet"><button>Ok</button></div>' +
            '<div role="dialog" class="sheet shaking" hidden></div>';
        });</script></body></html>`,
      );
      const result = await new KeyboardTester({ ...config, testEscapeHandling: true }).run(
        page,
        'template',
      );
      const escape = result.interactions.filter((i) => i.key === 'Escape');
      expect(escape.map((i) => i.success)).toEqual([false]);
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
