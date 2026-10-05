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
    // Exact class list, so a sibling sharing its first class is not taken for it. No match
    // (the re-render changed its classes) is unknown, not dismissed: the count decides.
    const match = all.find(
      (el) =>
        el.tagName === tag &&
        (Element.prototype.getAttribute.call(el, 'class') ?? '').trim() === cls,
    );
    same = match ? isVisible(match) : null;
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
        focusOrder = await this.testFocusOrder(page);
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
   * Test focus order by tabbing through all focusable elements
   */
  private async testFocusOrder(page: Page): Promise<FocusableElement[]> {
    return await page.evaluate(() => {
      const focusableSelectors = [
        'a[href]',
        'area[href]',
        'input:not([disabled])',
        'select:not([disabled])',
        'textarea:not([disabled])',
        'button:not([disabled])',
        '[tabindex]:not([tabindex="-1"])',
        '[contenteditable]',
      ].join(',');

      const elements = Array.from(document.querySelectorAll(focusableSelectors));

      return elements.map((el) => {
        const htmlEl = el as HTMLElement;
        const rect = htmlEl.getBoundingClientRect();
        const isVisible =
          rect.width > 0 &&
          rect.height > 0 &&
          window.getComputedStyle(htmlEl).visibility !== 'hidden';

        // A label, never a selector. `getAttribute('class')`, not `className`: on an SVG
        // <a> that is an SVGAnimatedString, and `.split` threw and ended the run (#285).
        // Through Element.prototype: a <form>'s named controls shadow its methods and
        // properties (`<input name="setAttribute">`), which threw and ended the run.
        const attr = (name: string) => Element.prototype.getAttribute.call(el, name);
        const id = attr('id');
        const firstClass = (attr('class') ?? '').trim().split(/\s+/)[0];
        return {
          element: el.tagName + (id ? `#${id}` : '') + (firstClass ? `.${firstClass}` : ''),
          tabIndex: htmlEl.tabIndex,
          focusable: true,
          visible: isVisible,
          tagName: el.tagName,
          role: attr('role') || undefined,
          ariaLabel: attr('aria-label') || undefined,
        };
      });
    });
  }

  /**
   * Validate that focus order is logical (left-to-right, top-to-bottom)
   */
  private validateFocusOrder(focusOrder: FocusableElement[]): boolean {
    // Check for negative tab indices on visible elements
    const negativeTabIndices = focusOrder.filter((el) => el.visible && el.tabIndex < 0);

    // Check for very high tab indices (potential manual ordering issues)
    const highTabIndices = focusOrder.filter((el) => el.tabIndex > 0);

    // If we have manual tab ordering, that's a potential issue
    return negativeTabIndices.length === 0 && highTabIndices.length === 0;
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
          // Present = our marked node, or (re-rendered) the same dialog by id or tag + class.
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
