/**
 * Keyboard Navigation Testing Module
 *
 * Provides comprehensive keyboard accessibility testing including:
 * - Focus order validation
 * - Focus trap detection
 * - Arrow key navigation
 * - Escape key handling
 * - Custom keyboard sequences
 *
 * NOTE: The page.evaluate() callbacks below are serialized and executed in the
 * browser's V8 context, not Node. Jest/Istanbul coverage instrumentation injects
 * cov_* counters that are undefined in the browser, so this module is excluded
 * from coverage instrumentation (see jest.config.ts). It is covered by the a11y
 * e2e suite, not Istanbul.
 */

import { randomBytes } from 'crypto';
import { Page } from 'playwright';
import type { KeyboardTestResult } from './types';

export interface KeyboardTestConfig {
  testFocusOrder: boolean;
  testTrapDetection: boolean;
  testArrowKeyNavigation: boolean;
  testEscapeHandling: boolean;
  customSequences: Array<{
    name: string;
    keys: string[];
    expectedBehavior: string;
    validator?: string; // Function as string to evaluate in browser
  }>;
}

export interface FocusableElement {
  element: string;
  tabIndex: number;
  focusable: boolean;
  visible: boolean;
  tagName: string;
  role?: string;
  ariaLabel?: string;
}

export interface FocusTrap {
  container: string;
  trapped: boolean;
  escapeMethod?: string;
  firstElement: string;
  lastElement: string;
}

export interface KeyboardInteraction {
  key: string;
  target: string;
  expectedBehavior: string;
  actualBehavior: string;
  success: boolean;
  timestamp: Date;
}

/**
 * In-page: is the marked element visible (null when it is gone), and how many
 * dismissible elements are visible. A string-free function is fine here: the a11y
 * modules are excluded from coverage instrumentation (see jest.config.ts).
 */
const DISMISSIBLE_STATE = ({
  selector,
  id,
  tag,
  cls,
}: {
  selector: string;
  id: string | null;
  tag: string;
  cls: string;
}): { marked: boolean | null; same: boolean | null; visibleCount: number } => {
  const isVisible = (el: Element) => {
    const style = getComputedStyle(el);
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      Element.prototype.getClientRects.call(el).length > 0
    );
  };
  const all = Array.from(
    document.querySelectorAll('[role="dialog"], [role="alertdialog"], .modal, [aria-modal="true"]'),
  );
  const marked = document.querySelector(selector);
  // A re-render that replaced the node: the same dialog is the element with its id, or,
  // without one, the dismissible element with its tag and exact class list (what the old
  // `TAG.class` selector found). With neither, it cannot be told apart: null.
  let same: boolean | null = null;
  if (id) {
    const byId = document.getElementById(id);
    same = !!byId && isVisible(byId);
  } else if (cls) {
    // Tag + exact class list is weak evidence: it may show the dialog is still open (a
    // visible match), never that it closed. A hidden template or a sibling sharing the
    // classes must not establish dismissal; anything short of a visible match is unknown,
    // and the visible count decides.
    const stillOpen = all.some(
      (el) =>
        el.tagName === tag &&
        (Element.prototype.getAttribute.call(el, 'class') ?? '').trim() === cls &&
        isVisible(el),
    );
    same = stillOpen ? true : null;
  }
  return {
    marked: marked ? isVisible(marked) : null,
    same,
    visibleCount: all.filter(isVisible).length,
  };
};

/**
 * An evaluate that died because the page navigated (a dialog whose Escape handler sends
 * the user elsewhere): that dialog was dismissed, not a failure of the check (#286).
 */
const destroyedByNavigation = (error: unknown): boolean =>
  error instanceof Error && /Execution context was destroyed|navigat/i.test(error.message);

/** A probe that matches no marker: DISMISSIBLE_STATE then only counts visible dialogs. */
const NO_PROBE = { selector: '[data-iris-none]', id: null, tag: '', cls: '' };

/**
 * KeyboardTester handles keyboard navigation and accessibility testing
 */
export class KeyboardTester {
  private config: KeyboardTestConfig;

  constructor(config: KeyboardTestConfig) {
    this.config = config;
  }

  /**
   * Run comprehensive keyboard navigation tests.
   *
   * Expects the page as loaded from its URL (the a11y runner navigates right before): the
   * Escape check reloads it after the trap check (#286), which reproduces that state but
   * not one opened by script afterwards. A reload that brings back fewer dialogs than the
   * trap check saw is reported as a failed check, never a silent pass.
   */
  async run(page: Page, testName: string): Promise<KeyboardTestResult> {
    const interactions: KeyboardInteraction[] = [];
    let focusOrder: FocusableElement[] = [];
    let trapTests: FocusTrap[] = [];
    let passed = true;

    try {
      // Dialogs showing on the page as loaded, before any check presses a key (the Tab walk
      // can open one, the trap check closes them): the Escape check's reload must bring
      // them back (#286).
      // The page under test, so the Escape check returns to it even if a key sent it
      // elsewhere (a dialog whose Escape handler navigates).
      const startUrl = page.url();
      const dialogsBefore =
        this.config.testTrapDetection && this.config.testEscapeHandling
          ? (await page.evaluate(DISMISSIBLE_STATE, NO_PROBE)).visibleCount
          : 0;

      // Test 1: Focus order
      if (this.config.testFocusOrder) {
        const walked = await this.testFocusOrder(page);
        focusOrder = walked.stops;
        if (walked.truncated) {
          interactions.push({
            key: 'Tab',
            target: 'page',
            expectedBehavior: 'Whole Tab order walked',
            actualBehavior: `Stopped after ${focusOrder.length} stops: the walk did not finish`,
            success: true, // informational: the stops it reached were still judged
            timestamp: new Date(),
          });
        }
        const focusOrderValid = this.validateFocusOrder(focusOrder);
        if (!focusOrderValid) {
          passed = false;
          interactions.push({
            key: 'Tab',
            target: 'page',
            expectedBehavior: 'Logical focus order',
            actualBehavior: 'Focus order contains issues',
            success: false,
            timestamp: new Date(),
          });
        }
      }

      // Test 2: Focus trap detection
      if (this.config.testTrapDetection) {
        trapTests = await this.testFocusTraps(page);
        const trapsValid = trapTests.every((trap) => !trap.trapped || trap.escapeMethod);
        if (!trapsValid) {
          passed = false;
          interactions.push({
            key: 'Tab/Escape',
            target: 'modal/dialog',
            expectedBehavior: 'Focus traps have escape mechanisms',
            actualBehavior: 'Some focus traps cannot be escaped',
            success: false,
            timestamp: new Date(),
          });
        }
      }

      // Test 3: Arrow key navigation
      if (this.config.testArrowKeyNavigation) {
        const arrowTests = await this.testArrowKeyNavigation(page);
        interactions.push(...arrowTests);
        if (arrowTests.some((test) => !test.success)) {
          passed = false;
        }
      }

      // Test 4: Escape key handling
      if (this.config.testEscapeHandling) {
        // The trap test pressed Escape on every dialog it examined, so one that closes on
        // Escape was gone by now and this test recorded nothing for it (#286). Start again
        // from the page as loaded. The URL guard is per page, so the reload is guarded too.
        if (trapTests.length > 0) {
          // 'load', not 'networkidle': a page with long-polling or a socket never goes idle.
          // A reload that fails leaves the page as it is: the check still runs, it does not
          // cost every result collected so far.
          try {
            if (page.url() === startUrl) await page.reload({ waitUntil: 'load' });
            else await page.goto(startUrl, { waitUntil: 'load' });
            // Settle as the runner does before the checks (dialogs mounted after a fetch),
            // but bounded: a page with a socket never goes idle.
            await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
          } catch {
            // Fall back to the current DOM.
          }
          const dialogsNow = (await page.evaluate(DISMISSIBLE_STATE, NO_PROBE)).visibleCount;
          if (dialogsNow < dialogsBefore) {
            passed = false;
            interactions.push({
              key: 'Escape',
              target: 'page',
              expectedBehavior: 'Each dialog tested with Escape',
              actualBehavior: `Reloading brought back ${dialogsNow} of ${dialogsBefore} dialog(s); the rest could not be tested`,
              success: false,
              timestamp: new Date(),
            });
          }
        }
        const escapeTests = await this.testEscapeHandling(page);
        interactions.push(...escapeTests);
        if (escapeTests.some((test) => !test.success)) {
          passed = false;
        }
      }

      // Test 5: Custom sequences
      if (this.config.customSequences.length > 0) {
        const customTests = await this.testCustomSequences(page);
        interactions.push(...customTests);
        if (customTests.some((test) => !test.success)) {
          passed = false;
        }
      }

      return {
        testName,
        passed,
        interactions,
        focusOrder,
        trapTests,
      };
    } catch (error) {
      throw new Error(
        `Keyboard testing failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Focus order as a keyboard user meets it: real Tab presses from the start of the
   * document (#286). It used to be a static selector scan, in DOM order, that never pressed
   * Tab. Stops when focus leaves the page, returns to a stop already seen (the order wrapped
   * or a trap cycles), or after `MAX_TAB_STOPS`.
   */
  private async testFocusOrder(
    page: Page,
  ): Promise<{ stops: FocusableElement[]; truncated: boolean }> {
    const MAX_TAB_STOPS = 200;
    // Where Tab starts is the browser's sequential-focus starting point, and nothing a page
    // script can do resets it to the document start (blur() leaves it at the blurred,
    // e.g. autofocused, element; focusing <body> puts it in the tree, where Tab skips
    // positive-tabindex elements). So the walk does not try: it blurs, and if focus wraps
    // to the document part-way, the stops after the wrap come first (see below).
    await page.evaluate(() => {
      const active = document.activeElement;
      if (active && active !== document.body) {
        // An SVG element's blur() is SVGElement's: HTMLElement's throws on it (GLM).
        try {
          (active instanceof SVGElement ? SVGElement : HTMLElement).prototype.blur.call(
            active as HTMLElement & SVGElement,
          );
        } catch {
          // Not blurrable this way: the walk still starts from wherever focus is.
        }
      }
    });

    // Stops before focus first wraps to the document, and after. If the walk began mid-page
    // (an autofocused control), the order a user meets from the top is after + before.
    const before: FocusableElement[] = [];
    const after: FocusableElement[] = [];
    let wrapped = false;
    const seen = new Set<string>();
    let lastPath = '';
    // Truncated means the press budget ran out before the walk finished: wraps and presses
    // inside an opaque frame or shadow root use presses without adding stops.
    let finished = false;
    for (let i = 0; i < MAX_TAB_STOPS; i++) {
      await page.keyboard.press('Tab');
      const stop = await page.evaluate(() => {
        // The element that really has focus: through shadow roots and same-origin iframes
        // (document.activeElement stays the host or the IFRAME while Tab moves inside).
        // A cross-origin iframe (or closed shadow root) is opaque: the host itself.
        const top = document.activeElement;
        if (!top || top === document.body || top === document.documentElement) return null;
        let el: Element = top;
        const path: string[] = [];
        // Within its own tree (an element in a shadow root has its root as parentNode). Read
        // through Node.prototype's getters: a <form>'s named controls shadow `children`,
        // `parentNode` and `parentElement` (an input named "children" gave every sibling the
        // same path, and the walk read them as one repeated stop).
        const getter = (name: 'parentNode' | 'parentElement' | 'childNodes') =>
          Object.getOwnPropertyDescriptor(Node.prototype, name)!.get!;
        const parentOf = getter('parentNode');
        const parentElementOf = getter('parentElement');
        const childNodesOf = getter('childNodes');
        const pathOf = (node: Element) => {
          const parts: string[] = [];
          for (let n: Node | null = node; n && n.nodeType === 1;) {
            const parent = parentOf.call(n) as Node | null;
            if (!parent) break;
            const index = Array.prototype.indexOf.call(childNodesOf.call(parent), n);
            parts.unshift(`${(n as Element).tagName}:${index}`);
            n = parent;
          }
          return parts.join('>');
        };
        // A positive tabindex on a frame or shadow host orders its whole focus scope ahead
        // of ordinary controls: carried down, so the stop inside is judged by it.
        let hostTabIndex = 0;
        const tabIndexOf = (e: Element) =>
          Number.parseInt(Element.prototype.getAttribute.call(e, 'tabindex') ?? '0', 10) || 0;
        for (;;) {
          path.push(pathOf(el));
          const inner: Element | null | undefined = el.shadowRoot?.activeElement;
          if (inner) {
            hostTabIndex = Math.max(hostTabIndex, tabIndexOf(el));
            el = inner;
            continue;
          }
          if (el.tagName === 'IFRAME') {
            let doc: Document | null = null;
            try {
              doc = (el as HTMLIFrameElement).contentDocument;
            } catch {
              doc = null;
            }
            const active: Element | null | undefined = doc?.activeElement;
            if (doc && active && active !== doc.body && active !== doc.documentElement) {
              hostTabIndex = Math.max(hostTabIndex, tabIndexOf(el));
              el = active;
              continue;
            }
          }
          break;
        }

        // Visible where focus landed: its own box, and nothing above it hidden (opacity is
        // not inherited by getComputedStyle, so ancestors are walked, across shadow roots).
        // An image map's <area> has no box (the UA stylesheet makes it display: none): it is
        // as visible as the <img> that uses its <map>.
        let shown: Element = el;
        if (el.tagName === 'AREA') {
          const map = Element.prototype.closest.call(el, 'map');
          const name = map ? Element.prototype.getAttribute.call(map, 'name') : null;
          const image = name
            ? (el.ownerDocument ?? document).querySelector(`img[usemap="#${CSS.escape(name)}"]`)
            : null;
          if (image) shown = image;
        }
        const rect = Element.prototype.getBoundingClientRect.call(shown);
        // The box counts when the element itself can take focus. One that cannot (a host
        // focused through a closed shadow root, standing in for a control the page cannot
        // see) may have no box of its own (display: contents) while its content shows:
        // inconclusive, so only the styles below decide.
        const canTakeFocus = Element.prototype.matches.call(
          shown,
          'a[href], area[href], img, button, input, select, textarea, iframe, summary, [tabindex], [contenteditable]',
        );
        let visible = !canTakeFocus || (rect.width > 0 && rect.height > 0);
        for (let n: Element | null = shown; n && visible;) {
          const style = getComputedStyle(n);
          // `visibility` is inherited and a descendant may override it, so only the focused
          // element's computed value counts; display and opacity hide everything below.
          if (
            style.display === 'none' ||
            (n === shown && style.visibility === 'hidden') ||
            Number(style.opacity) === 0
          ) {
            visible = false;
          }
          // Up through a shadow root's host and, at the top of a same-origin frame's
          // document, its <iframe> in the outer page: hidden there hides everything inside.
          // A shadow root is detected by shape, not instanceof (each frame has its own realm).
          const root = Node.prototype.getRootNode.call(n) as Node & { host?: Element };
          n =
            (parentElementOf.call(n) as Element | null) ??
            (root.nodeType === 11 && root.host
              ? root.host
              : (n.ownerDocument?.defaultView?.frameElement ?? null));
        }

        // Through the prototypes: a <form>'s named controls shadow its methods (#285).
        const node = el;
        const attr = (name: string) => Element.prototype.getAttribute.call(node, name);
        const id = attr('id');
        const firstClass = (attr('class') ?? '').trim().split(/\s+/)[0];
        const role = attr('role');
        const ariaLabel = attr('aria-label');
        return {
          path: path.join('|'),
          tagName: el.tagName,
          ...(role && { role }),
          ...(ariaLabel && { ariaLabel }),
          element: el.tagName + (id ? `#${id}` : '') + (firstClass ? `.${firstClass}` : ''),
          tabIndex:
            Math.max(tabIndexOf(el), hostTabIndex) > 0
              ? Math.max(tabIndexOf(el), hostTabIndex)
              : tabIndexOf(el),
          visible,
        };
      });
      if (!stop) {
        // Focus left the page: the first time, the walk wrapped to the document start
        // (keep going); the second time, it has seen everything.
        if (wrapped) {
          finished = true;
          break;
        }
        wrapped = true;
        lastPath = '';
        continue;
      }
      // The same stop twice in a row is not a cycle (a cycle returns to an earlier stop):
      // Tab is moving inside something the page cannot see into, a cross-origin frame or a
      // closed shadow root. Keep pressing until focus moves on; the cap bounds the rest.
      if (stop.path === lastPath) continue;
      if (seen.has(stop.path)) {
        finished = true;
        break;
      }
      seen.add(stop.path);
      lastPath = stop.path;
      const { path: _path, ...element } = stop;
      (wrapped ? after : before).push({ ...element, focusable: true });
    }
    const stops = [...after, ...before];
    // Reaching the cap means the walk did not see the whole order: said, not silent.
    return { stops, truncated: !finished };
  }

  /**
   * The Tab order is acceptable when no stop is ordered by a positive tabindex (it
   * overrides the document order, WCAG 2.4.3) and every stop is visible where focus lands
   * on it (2.4.7). A negative tabindex is never a failure: it is how the roving-tabindex
   * pattern keeps a widget's other items out of the Tab order, and Tab never reaches them.
   */
  private validateFocusOrder(focusOrder: FocusableElement[]): boolean {
    return focusOrder.every((stop) => stop.tabIndex <= 0 && stop.visible);
  }

  /**
   * Identity of the currently focused element, as a structural path.
   *
   * Tag names alone cannot tell two sibling menu items apart, so focus movement
   * has to be compared on something unique. Returns null when nothing
   * meaningful holds focus (i.e. focus is on <body>).
   */
  private async activeElementPath(page: Page): Promise<string | null> {
    return page.evaluate(() => {
      const active = document.activeElement;
      if (!active || active === document.body) return null;

      // Through Node.prototype's getters: a <form>'s named controls shadow `parentElement`
      // and `children`, and reading them directly looped input -> form -> input forever.
      const parentElementOf = Object.getOwnPropertyDescriptor(
        Node.prototype,
        'parentElement',
      )!.get!;
      const childNodesOf = Object.getOwnPropertyDescriptor(Node.prototype, 'childNodes')!.get!;
      const parts: string[] = [];
      let node: Element | null = active;
      for (let parent = parentElementOf.call(node) as Element | null; node && parent;) {
        const index = Array.prototype.indexOf.call(childNodesOf.call(parent), node);
        parts.unshift(`${node.tagName}:${index}`);
        node = parent;
        parent = parentElementOf.call(node) as Element | null;
      }
      return parts.join('>');
    });
  }

  /**
   * Test for focus traps (modals, dialogs that trap focus).
   *
   * This drives the keyboard for real. The previous implementation inferred
   * `trapped: true` for anything that merely looked like a dialog and guessed
   * `escapeMethod` from the presence of a close-ish selector, so a dialog that
   * leaked focus passed and one that closed via a JS Escape handler was missed.
   */
  private async testFocusTraps(page: Page): Promise<FocusTrap[]> {
    const CONTAINERS = '[role="dialog"], [role="alertdialog"], .modal, [aria-modal="true"]';
    const FOCUSABLE =
      'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

    // Tag candidates so each can be re-found after the DOM shifts (a dismissed
    // dialog may be removed outright, which would invalidate positional lookup).
    // A per-run attribute name, as for the keyboard markers: a page's own data-iris-trap
    // attribute is never matched, overwritten or removed.
    const attr = `data-iris-trap-${randomBytes(4).toString('hex')}`;
    const candidates = await page.evaluate(
      ({ containers, focusable, attr }) => {
        const isVisible = (el: Element) => {
          const style = getComputedStyle(el);
          // Not offsetParent: that is null for position:fixed modals even when shown.
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            el.getClientRects().length > 0
          );
        };
        const describe = (el: Element | undefined) =>
          el
            ? el.tagName +
              ((id) => (id ? `#${id}` : ''))(Element.prototype.getAttribute.call(el, 'id'))
            : '';

        return Array.from(document.querySelectorAll(containers))
          .filter(isVisible)
          .map((container, index) => {
            // Through Element.prototype: a <form>'s named controls shadow its methods (#285).
            Element.prototype.setAttribute.call(container, attr, String(index));
            const inside = Element.prototype.querySelectorAll.call(container, focusable);
            return {
              index,
              container: describe(container),
              focusableCount: inside.length,
              firstElement: describe(inside[0]),
              lastElement: describe(inside[inside.length - 1]),
            };
          });
      },
      { containers: CONTAINERS, focusable: FOCUSABLE, attr },
    );

    const traps: FocusTrap[] = [];
    try {
      for (const candidate of candidates) {
        if (candidate.focusableCount === 0) continue;

        // Tab off the LAST focusable: a real trap wraps back to the first,
        // a leaky one lets focus escape to the document.
        await page.evaluate(
          ({ index, focusable, attr }) => {
            const container = document.querySelector(`[${attr}="${index}"]`);
            const inside = container
              ? Element.prototype.querySelectorAll.call(container, focusable)
              : undefined;
            (inside?.[inside.length - 1] as HTMLElement | undefined)?.focus();
          },
          { index: candidate.index, focusable: FOCUSABLE, attr },
        );
        await page.keyboard.press('Tab');

        const trapped = await page.evaluate(
          ({ index, attr }) => {
            const container = document.querySelector(`[${attr}="${index}"]`);
            return (
              !!container &&
              !!document.activeElement &&
              Node.prototype.contains.call(container, document.activeElement)
            );
          },
          { index: candidate.index, attr },
        );

        await page.keyboard.press('Escape');

        let navigated = false;
        const escaped = await page
          .evaluate(
            ({ index, attr }) => {
              const el = document.querySelector(`[${attr}="${index}"]`);
              if (!el) return true; // removed from the DOM entirely
              const style = getComputedStyle(el);
              return (
                style.display === 'none' ||
                style.visibility === 'hidden' ||
                el.getClientRects().length === 0
              );
            },
            { index: candidate.index, attr },
          )
          .catch((error: unknown) => {
            if (!destroyedByNavigation(error)) throw error;
            navigated = true; // Escape left the page: dismissed
            return true;
          });

        traps.push({
          container: candidate.container,
          trapped,
          // Only claim an escape route that was actually observed to work.
          escapeMethod: escaped ? 'Escape' : undefined,
          firstElement: candidate.firstElement,
          lastElement: candidate.lastElement,
        });
        // The other candidates were on the page it left; the Escape check returns to it.
        if (navigated) break;
      }
    } finally {
      // Leave the page as we found it — the markers are ours, not the app's.
      try {
        await page.evaluate(
          (attr) =>
            document
              .querySelectorAll(`[${attr}]`)
              .forEach((el) => Element.prototype.removeAttribute.call(el, attr)),
          attr,
        );
      } catch {
        // Cleanup only: a page that navigated away took the markers with it.
      }
    }

    return traps;
  }

  /**
   * Test arrow key navigation in components like menus and lists
   */
  private async testArrowKeyNavigation(page: Page): Promise<KeyboardInteraction[]> {
    const interactions: KeyboardInteraction[] = [];

    // Find elements with arrow key navigation (menus, listboxes, etc.)
    // Each widget is addressed by a marker of ours, not a selector built from its id and
    // class: Radix ids (`radix-:r1:`), Tailwind classes (`md:w-[400px]`) and id-less,
    // class-less elements made invalid or ambiguous selectors (#285). Removed afterwards.
    // A per-run attribute NAME: a page's own attributes are never matched, overwritten or
    // removed, whatever they are called.
    const nonce = randomBytes(4).toString('hex');
    const arrowNavigableElements = await page.evaluate((nonce) => {
      const elements = document.querySelectorAll(
        '[role="menu"], [role="listbox"], [role="tree"], [role="grid"], [role="tablist"]',
      );
      return Array.from(elements).map((el, i) => {
        Element.prototype.setAttribute.call(el, `data-iris-kbd-${nonce}`, `arrow-${i}`);
        // Through Element.prototype: a <form>'s named controls shadow its methods and
        // properties (`<input name="setAttribute">`), which threw and ended the run.
        const attr = (name: string) => Element.prototype.getAttribute.call(el, name);
        const id = attr('id');
        const firstClass = (attr('class') ?? '').trim().split(/\s+/)[0];
        return {
          selector: `[data-iris-kbd-${nonce}="arrow-${i}"]`,
          label: el.tagName + (id ? `#${id}` : '') + (firstClass ? `.${firstClass}` : ''),
          role: attr('role'),
        };
      });
    }, nonce);

    try {
      for (const element of arrowNavigableElements) {
        try {
          // Focus the element. A composite widget usually delegates focus to its
          // active descendant, so read where focus actually landed rather than
          // assuming it sits on the container.
          try {
            await page.focus(element.selector);
          } catch {
            // Focusing the container can legitimately fail; the fallback below
            // decides whether focus actually landed somewhere useful.
          }

          // page.focus() is a silent no-op on a non-focusable container, which is
          // the normal shape of a roving-tabindex widget (`<ul role="menu">` with
          // focus on its items). Without this fallback the key press never reaches
          // the widget's handler and a perfectly good menu false-fails.
          await page.evaluate((selector) => {
            const container = document.querySelector(selector);
            if (!container) return;

            const active = document.activeElement;
            if (
              active &&
              active !== document.body &&
              Node.prototype.contains.call(container, active)
            )
              return;

            const candidate = Element.prototype.querySelector.call(
              container,
              '[tabindex]:not([tabindex="-1"]), [tabindex="-1"], a[href], button:not([disabled]),' +
                ' input:not([disabled]), [role="menuitem"], [role="option"], [role="tab"], [role="treeitem"]',
            );
            (candidate as HTMLElement | null)?.focus();
          }, element.selector);

          const before = await this.activeElementPath(page);
          await page.keyboard.press('ArrowDown');
          const after = await this.activeElementPath(page);

          // The verdict is whether focus MOVED. Previously this was hardcoded true,
          // so a menu that ignored arrow keys entirely still passed.
          const moved = after !== null && after !== before;

          interactions.push({
            key: 'ArrowDown',
            target: element.label,
            expectedBehavior: `Focus moves to next item in ${element.role}`,
            actualBehavior: moved
              ? `Focus moved to ${after}`
              : `Focus did not move (${before ?? 'nothing focused'})`,
            success: moved,
            timestamp: new Date(),
          });
        } catch {
          interactions.push({
            key: 'ArrowDown',
            target: element.label,
            expectedBehavior: `Focus moves to next item in ${element.role}`,
            actualBehavior: 'Failed to test navigation',
            success: false,
            timestamp: new Date(),
          });
        }
      }
    } finally {
      // A page that navigated mid-test has no markers left; a failed cleanup must not
      // replace the results collected so far.
      try {
        await page.evaluate(
          (nonce) =>
            document
              .querySelectorAll(`[data-iris-kbd-${nonce}]`)
              .forEach((el) =>
                Element.prototype.removeAttribute.call(el, `data-iris-kbd-${nonce}`),
              ),
          nonce,
        );
      } catch {
        // Cleanup only.
      }
    }

    return interactions;
  }

  /**
   * Test escape key handling for dismissible components
   */
  private async testEscapeHandling(page: Page): Promise<KeyboardInteraction[]> {
    const interactions: KeyboardInteraction[] = [];

    // Find dismissible components. Visibility deliberately avoids offsetParent:
    // it is null for position:fixed elements, which describes most real modals,
    // so those were skipped here and silently recorded as passing Escape handling.
    const nonce = randomBytes(4).toString('hex');
    const dismissibleElements = await page.evaluate((nonce) => {
      const isVisible = (el: Element) => {
        const style = getComputedStyle(el);
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          el.getClientRects().length > 0
        );
      };

      const elements = document.querySelectorAll(
        '[role="dialog"], [role="alertdialog"], .modal, [aria-modal="true"]',
      );
      // Addressed by a marker of ours, as in arrow navigation (#285).
      return Array.from(elements).map((el, i) => {
        Element.prototype.setAttribute.call(el, `data-iris-kbd-${nonce}`, `escape-${i}`);
        // Through Element.prototype: a <form>'s named controls shadow its methods and
        // properties (`<input name="setAttribute">`), which threw and ended the run.
        const attr = (name: string) => Element.prototype.getAttribute.call(el, name);
        const id = attr('id');
        const firstClass = (attr('class') ?? '').trim().split(/\s+/)[0];
        return {
          selector: `[data-iris-kbd-${nonce}="escape-${i}"]`,
          id,
          tag: el.tagName,
          cls: (attr('class') ?? '').trim(),
          label: el.tagName + (id ? `#${id}` : '') + (firstClass ? `.${firstClass}` : ''),
          visible: isVisible(el),
        };
      });
    }, nonce);

    try {
      for (const element of dismissibleElements) {
        if (!element.visible) continue;

        try {
          const probe = {
            selector: element.selector,
            id: element.id,
            tag: element.tag,
            cls: element.cls,
          };
          const before = await page.evaluate(DISMISSIBLE_STATE, probe);
          // Already dismissed by an earlier candidate's Escape (a .modal wrapper and its
          // inner [role=dialog], stacked modals closed by one handler): nothing to test.
          // Skip a candidate that is gone before its turn: our node hidden or removed and
          // nothing identifies a replacement (an id, or tag + class that is still showing).
          // Testing it instead would press Escape on whatever else is showing and record a
          // failure against an element that no longer exists (a .modal wrapper and its
          // inner panel closed together beside a persistent chat dialog). A re-render that
          // changes an id-less dialog's markup before its turn is then not tested: proper
          // Escape semantics (topmost focused dialog) are #286, which has that fixture.
          if (!(before.marked ?? before.same ?? false)) continue;
          // Escape goes to the focused element. After the reload nothing inside the dialog
          // has focus, and a handler on the dialog itself never sees a key sent to <body>.
          await page.evaluate((selector) => {
            const dialog = document.querySelector(selector);
            if (!dialog) return;
            const inside = () =>
              !!document.activeElement &&
              Node.prototype.contains.call(dialog, document.activeElement);
            if (inside()) return; // keep a control the page focused itself
            // The first one that really takes focus: a hidden or inert one silently does not.
            const candidates = Element.prototype.querySelectorAll.call(
              dialog,
              'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]),' +
                ' textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
            );
            for (const candidate of Array.from(candidates)) {
              // An SVG <a> is not an HTMLElement: its focus() is SVGElement's.
              try {
                (candidate instanceof SVGElement ? SVGElement : HTMLElement).prototype.focus.call(
                  candidate as HTMLElement & SVGElement,
                );
              } catch {
                continue; // not focusable this way: try the next one
              }
              if (inside()) return;
            }
            if (!Element.prototype.hasAttribute.call(dialog, 'tabindex')) {
              Element.prototype.setAttribute.call(dialog, 'tabindex', '-1');
            }
            // An SVG dialog's focus() is SVGElement's, as for the candidates above.
            (dialog instanceof SVGElement ? SVGElement : HTMLElement).prototype.focus.call(
              dialog as HTMLElement & SVGElement,
            );
          }, element.selector);
          await page.keyboard.press('Escape');
          const after = await page.evaluate(DISMISSIBLE_STATE, probe).catch((error: unknown) => {
            if (!destroyedByNavigation(error)) throw error;
            return null; // Escape left the page: dismissed
          });
          if (after === null) {
            interactions.push({
              key: 'Escape',
              target: element.label,
              expectedBehavior: 'Modal/dialog closes on Escape',
              actualBehavior: 'Closed (the page navigated)',
              success: true,
              timestamp: new Date(),
            });
            break; // the remaining candidates were on the page it left
          }

          // Our marked element still there: its own visibility decides. Gone (a handler
          // that replaced the node, as a framework re-render does): an element with its
          // id decides, as the id lookup did before markers; with no id, dismissed only if
          // fewer dismissible elements are visible now. A bare null check read a
          // replaced-but-open dialog as closed. ponytail: the count is a heuristic for
          // id-less re-renders; Escape semantics proper are #491.
          const stillVisible =
            after.marked !== null
              ? after.marked
              : after.same !== null
                ? after.same
                : after.visibleCount >= before.visibleCount;

          interactions.push({
            key: 'Escape',
            target: element.label,
            expectedBehavior: 'Modal/dialog closes on Escape',
            actualBehavior: stillVisible ? 'Still visible' : 'Closed',
            success: !stillVisible,
            timestamp: new Date(),
          });
        } catch {
          interactions.push({
            key: 'Escape',
            target: element.label,
            expectedBehavior: 'Modal/dialog closes on Escape',
            actualBehavior: 'Failed to test',
            success: false,
            timestamp: new Date(),
          });
        }
      }
    } finally {
      // A page that navigated mid-test has no markers left; a failed cleanup must not
      // replace the results collected so far.
      try {
        await page.evaluate(
          (nonce) =>
            document
              .querySelectorAll(`[data-iris-kbd-${nonce}]`)
              .forEach((el) =>
                Element.prototype.removeAttribute.call(el, `data-iris-kbd-${nonce}`),
              ),
          nonce,
        );
      } catch {
        // Cleanup only.
      }
    }

    return interactions;
  }

  /**
   * Test custom keyboard sequences
   */
  private async testCustomSequences(page: Page): Promise<KeyboardInteraction[]> {
    const interactions: KeyboardInteraction[] = [];

    for (const sequence of this.config.customSequences) {
      try {
        // Execute key sequence
        for (const key of sequence.keys) {
          await page.keyboard.press(key);
          await page.waitForTimeout(100); // Small delay between keys
        }

        // Validate behavior if validator provided
        let success = true;
        let actualBehavior = sequence.expectedBehavior;

        if (sequence.validator) {
          const result = await page.evaluate(sequence.validator);
          success = Boolean(result);
          actualBehavior = success ? sequence.expectedBehavior : 'Validation failed';
        }

        interactions.push({
          key: sequence.keys.join('+'),
          target: sequence.name,
          expectedBehavior: sequence.expectedBehavior,
          actualBehavior,
          success,
          timestamp: new Date(),
        });
      } catch {
        interactions.push({
          key: sequence.keys.join('+'),
          target: sequence.name,
          expectedBehavior: sequence.expectedBehavior,
          actualBehavior: 'Failed to execute sequence',
          success: false,
          timestamp: new Date(),
        });
      }
    }

    return interactions;
  }
}
