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
 * KeyboardTester handles keyboard navigation and accessibility testing
 */
export class KeyboardTester {
  private config: KeyboardTestConfig;

  constructor(config: KeyboardTestConfig) {
    this.config = config;
  }

  /**
   * Run comprehensive keyboard navigation tests
   */
  async run(page: Page, testName: string): Promise<KeyboardTestResult> {
    const interactions: KeyboardInteraction[] = [];
    let focusOrder: FocusableElement[] = [];
    let trapTests: FocusTrap[] = [];
    let passed = true;

    try {
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
            await page.reload({ waitUntil: 'load' });
          } catch {
            // Fall back to the current DOM.
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
      if (active && active !== document.body) HTMLElement.prototype.blur.call(active);
    });

    // Stops before focus first wraps to the document, and after. If the walk began mid-page
    // (an autofocused control), the order a user meets from the top is after + before.
    const before: FocusableElement[] = [];
    const after: FocusableElement[] = [];
    let wrapped = false;
    const seen = new Set<string>();
    let lastPath = '';
    // Truncated means the press budget ran out before the walk finished: wraps and presses
    // inside an opaque frame use presses without adding stops.
    let finished = false;
    for (let i = 0; i < MAX_TAB_STOPS; i++) {
      await page.keyboard.press('Tab');
      const stop = await page.evaluate(() => {
        // The element that really has focus: through shadow roots and same-origin iframes
        // (document.activeElement stays the host or the IFRAME while Tab moves inside).
        // A cross-origin iframe is opaque: the IFRAME itself, marked so.
        const top = document.activeElement;
        if (!top || top === document.body || top === document.documentElement) return null;
        let el: Element = top;
        const path: string[] = [];
        let opaque = false;
        // Within its own tree: an element in a shadow root has no parentElement at the top,
        // so its siblings are the root's children.
        const pathOf = (node: Element) => {
          const parts: string[] = [];
          for (let n: Element | null = node; n; n = n.parentElement) {
            const parent = n.parentNode as ParentNode | null;
            if (!parent || !('children' in parent)) break;
            parts.unshift(`${n.tagName}:${Array.prototype.indexOf.call(parent.children, n)}`);
          }
          return parts.join('>');
        };
        for (;;) {
          path.push(pathOf(el));
          const inner: Element | null | undefined = el.shadowRoot?.activeElement;
          if (inner) {
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
            if (!doc) opaque = true;
            else if (active && active !== doc.body && active !== doc.documentElement) {
              el = active;
              continue;
            }
          }
          break;
        }

        // Visible where focus landed: its own box, and nothing above it hidden (opacity is
        // not inherited by getComputedStyle, so ancestors are walked, across shadow roots).
        const rect = Element.prototype.getBoundingClientRect.call(el);
        let visible = rect.width > 0 && rect.height > 0;
        for (let n: Element | null = el; n && visible;) {
          const style = getComputedStyle(n);
          // `visibility` is inherited and a descendant may override it, so only the focused
          // element's computed value counts; display and opacity hide everything below.
          if (
            style.display === 'none' ||
            (n === el && style.visibility === 'hidden') ||
            Number(style.opacity) === 0
          ) {
            visible = false;
          }
          // Up through a shadow root's host and, at the top of a same-origin frame's
          // document, its <iframe> in the outer page: hidden there hides everything inside.
          // A shadow root is detected by shape, not instanceof (each frame has its own realm).
          const root = Node.prototype.getRootNode.call(n) as Node & { host?: Element };
          n =
            n.parentElement ??
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
          opaque,
          tagName: el.tagName,
          ...(role && { role }),
          ...(ariaLabel && { ariaLabel }),
          element: el.tagName + (id ? `#${id}` : '') + (firstClass ? `.${firstClass}` : ''),
          tabIndex: Number.parseInt(attr('tabindex') ?? '0', 10) || 0,
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
      // Tab moving inside a cross-origin frame shows the same IFRAME each time: keep
      // pressing until focus leaves it (bounded by the cap), it is not a cycle.
      if (stop.opaque && stop.path === lastPath) continue;
      if (seen.has(stop.path)) {
        finished = true;
        break;
      }
      seen.add(stop.path);
      lastPath = stop.path;
      const { path: _path, opaque: _opaque, ...element } = stop;
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

      const parts: string[] = [];
      let node: Element | null = active;
      while (node && node.parentElement) {
        const index = Array.prototype.indexOf.call(node.parentElement.children, node);
        parts.unshift(`${node.tagName}:${index}`);
        node = node.parentElement;
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

        const escaped = await page.evaluate(
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
        );

        traps.push({
          container: candidate.container,
          trapped,
          // Only claim an escape route that was actually observed to work.
          escapeMethod: escaped ? 'Escape' : undefined,
          firstElement: candidate.firstElement,
          lastElement: candidate.lastElement,
        });
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
          await page.keyboard.press('Escape');
          const after = await page.evaluate(DISMISSIBLE_STATE, probe);

          // Our marked element still there: its own visibility decides. Gone (a handler
          // that replaced the node, as a framework re-render does): an element with its
          // id decides, as the id lookup did before markers; with no id, dismissed only if
          // fewer dismissible elements are visible now. A bare null check read a
          // replaced-but-open dialog as closed. ponytail: the count is a heuristic for
          // id-less re-renders; Escape semantics proper are #286.
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
