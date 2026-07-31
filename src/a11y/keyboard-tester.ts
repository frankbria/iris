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

        return {
          element:
            el.tagName +
            (el.id ? `#${el.id}` : '') +
            (el.className ? `.${el.className.split(' ')[0]}` : ''),
          tabIndex: htmlEl.tabIndex,
          focusable: true,
          visible: isVisible,
          tagName: el.tagName,
          role: el.getAttribute('role') || undefined,
          ariaLabel: el.getAttribute('aria-label') || undefined,
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
    const candidates = await page.evaluate(
      ({ containers, focusable }) => {
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
          el ? el.tagName + (el.id ? `#${el.id}` : '') : '';

        return Array.from(document.querySelectorAll(containers))
          .filter(isVisible)
          .map((container, index) => {
            container.setAttribute('data-iris-trap', String(index));
            const inside = container.querySelectorAll(focusable);
            return {
              index,
              container: describe(container),
              focusableCount: inside.length,
              firstElement: describe(inside[0]),
              lastElement: describe(inside[inside.length - 1]),
            };
          });
      },
      { containers: CONTAINERS, focusable: FOCUSABLE },
    );

    const traps: FocusTrap[] = [];
    try {
      for (const candidate of candidates) {
        if (candidate.focusableCount === 0) continue;

        // Tab off the LAST focusable: a real trap wraps back to the first,
        // a leaky one lets focus escape to the document.
        await page.evaluate(
          ({ index, focusable }) => {
            const container = document.querySelector(`[data-iris-trap="${index}"]`);
            const inside = container?.querySelectorAll(focusable);
            (inside?.[inside.length - 1] as HTMLElement | undefined)?.focus();
          },
          { index: candidate.index, focusable: FOCUSABLE },
        );
        await page.keyboard.press('Tab');

        const trapped = await page.evaluate((index) => {
          const container = document.querySelector(`[data-iris-trap="${index}"]`);
          return (
            !!container && !!document.activeElement && container.contains(document.activeElement)
          );
        }, candidate.index);

        await page.keyboard.press('Escape');

        const escaped = await page.evaluate((index) => {
          const el = document.querySelector(`[data-iris-trap="${index}"]`);
          if (!el) return true; // removed from the DOM entirely
          const style = getComputedStyle(el);
          return (
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            el.getClientRects().length === 0
          );
        }, candidate.index);

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
      await page.evaluate(() =>
        document
          .querySelectorAll('[data-iris-trap]')
          .forEach((el) => el.removeAttribute('data-iris-trap')),
      );
    }

    return traps;
  }

  /**
   * Test arrow key navigation in components like menus and lists
   */
  private async testArrowKeyNavigation(page: Page): Promise<KeyboardInteraction[]> {
    const interactions: KeyboardInteraction[] = [];

    // Find elements with arrow key navigation (menus, listboxes, etc.)
    const arrowNavigableElements = await page.evaluate(() => {
      const elements = document.querySelectorAll(
        '[role="menu"], [role="listbox"], [role="tree"], [role="grid"], [role="tablist"]',
      );
      return Array.from(elements).map((el) => ({
        selector: el.tagName + (el.id ? `#${el.id}` : `.${el.className.split(' ')[0]}`),
        role: el.getAttribute('role'),
      }));
    });

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
          if (active && active !== document.body && container.contains(active)) return;

          const candidate = container.querySelector(
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
          target: element.selector,
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
          target: element.selector,
          expectedBehavior: `Focus moves to next item in ${element.role}`,
          actualBehavior: 'Failed to test navigation',
          success: false,
          timestamp: new Date(),
        });
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
    const dismissibleElements = await page.evaluate(() => {
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
      return Array.from(elements).map((el) => ({
        selector: el.tagName + (el.id ? `#${el.id}` : `.${el.className.split(' ')[0]}`),
        visible: isVisible(el),
      }));
    });

    for (const element of dismissibleElements) {
      if (!element.visible) continue;

      try {
        // Press Escape
        await page.keyboard.press('Escape');

        // Check if element is still visible (same fixed-position caveat as above).
        const stillVisible = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) return false; // removed from the DOM counts as dismissed
          const style = getComputedStyle(el);
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            el.getClientRects().length > 0
          );
        }, element.selector);

        interactions.push({
          key: 'Escape',
          target: element.selector,
          expectedBehavior: 'Modal/dialog closes on Escape',
          actualBehavior: stillVisible ? 'Still visible' : 'Closed',
          success: !stillVisible,
          timestamp: new Date(),
        });
      } catch {
        interactions.push({
          key: 'Escape',
          target: element.selector,
          expectedBehavior: 'Modal/dialog closes on Escape',
          actualBehavior: 'Failed to test',
          success: false,
          timestamp: new Date(),
        });
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
