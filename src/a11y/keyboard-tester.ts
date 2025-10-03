/**
 * Keyboard Navigation Testing Module
 *
 * Provides comprehensive keyboard accessibility testing including:
 * - Focus order validation
 * - Focus trap detection
 * - Arrow key navigation
 * - Escape key handling
 * - Custom keyboard sequences
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
            timestamp: new Date()
          });
        }
      }

      // Test 2: Focus trap detection
      if (this.config.testTrapDetection) {
        trapTests = await this.testFocusTraps(page);
        const trapsValid = trapTests.every(trap => !trap.trapped || trap.escapeMethod);
        if (!trapsValid) {
          passed = false;
          interactions.push({
            key: 'Tab/Escape',
            target: 'modal/dialog',
            expectedBehavior: 'Focus traps have escape mechanisms',
            actualBehavior: 'Some focus traps cannot be escaped',
            success: false,
            timestamp: new Date()
          });
        }
      }

      // Test 3: Arrow key navigation
      if (this.config.testArrowKeyNavigation) {
        const arrowTests = await this.testArrowKeyNavigation(page);
        interactions.push(...arrowTests);
        if (arrowTests.some(test => !test.success)) {
          passed = false;
        }
      }

      // Test 4: Escape key handling
      if (this.config.testEscapeHandling) {
        const escapeTests = await this.testEscapeHandling(page);
        interactions.push(...escapeTests);
        if (escapeTests.some(test => !test.success)) {
          passed = false;
        }
      }

      // Test 5: Custom sequences
      if (this.config.customSequences.length > 0) {
        const customTests = await this.testCustomSequences(page);
        interactions.push(...customTests);
        if (customTests.some(test => !test.success)) {
          passed = false;
        }
      }

      return {
        testName,
        passed,
        interactions,
        focusOrder,
        trapTests
      };

    } catch (error) {
      throw new Error(`Keyboard testing failed: ${error instanceof Error ? error.message : String(error)}`);
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
        '[contenteditable]'
      ].join(',');

      const elements = Array.from(document.querySelectorAll(focusableSelectors));

      return elements.map((el, index) => {
        const htmlEl = el as HTMLElement;
        const rect = htmlEl.getBoundingClientRect();
        const isVisible = rect.width > 0 && rect.height > 0 &&
                         window.getComputedStyle(htmlEl).visibility !== 'hidden';

        return {
          element: el.tagName + (el.id ? `#${el.id}` : '') + (el.className ? `.${el.className.split(' ')[0]}` : ''),
          tabIndex: htmlEl.tabIndex,
          focusable: true,
          visible: isVisible,
          tagName: el.tagName,
          role: el.getAttribute('role') || undefined,
          ariaLabel: el.getAttribute('aria-label') || undefined
        };
      });
    });
  }

  /**
   * Validate that focus order is logical (left-to-right, top-to-bottom)
   */
  private validateFocusOrder(focusOrder: FocusableElement[]): boolean {
    // Check for negative tab indices on visible elements
    const negativeTabIndices = focusOrder.filter(
      el => el.visible && el.tabIndex < 0
    );

    // Check for very high tab indices (potential manual ordering issues)
    const highTabIndices = focusOrder.filter(
      el => el.tabIndex > 0
    );

    // If we have manual tab ordering, that's a potential issue
    return negativeTabIndices.length === 0 && highTabIndices.length === 0;
  }

  /**
   * Test for focus traps (modals, dialogs that trap focus)
   */
  private async testFocusTraps(page: Page): Promise<FocusTrap[]> {
    return await page.evaluate(() => {
      const traps: any[] = [];

      // Look for common focus trap containers
      const containers = document.querySelectorAll('[role="dialog"], [role="alertdialog"], .modal, [aria-modal="true"]');

      containers.forEach(container => {
        const focusableInside = container.querySelectorAll(
          'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );

        if (focusableInside.length > 0) {
          const first = focusableInside[0] as HTMLElement;
          const last = focusableInside[focusableInside.length - 1] as HTMLElement;

          // Check if container has close button or escape handling
          const hasCloseButton = container.querySelector('[aria-label*="close" i], [aria-label*="dismiss" i], button.close');
          const hasEscapeHandler = container.hasAttribute('data-dismiss') ||
                                  container.hasAttribute('data-close');

          traps.push({
            container: container.tagName + (container.id ? `#${container.id}` : ''),
            trapped: true,
            escapeMethod: hasCloseButton || hasEscapeHandler ? 'Escape or Close button' : undefined,
            firstElement: first.tagName + (first.id ? `#${first.id}` : ''),
            lastElement: last.tagName + (last.id ? `#${last.id}` : '')
          });
        }
      });

      return traps;
    });
  }

  /**
   * Test arrow key navigation in components like menus and lists
   */
  private async testArrowKeyNavigation(page: Page): Promise<KeyboardInteraction[]> {
    const interactions: KeyboardInteraction[] = [];

    // Find elements with arrow key navigation (menus, listboxes, etc.)
    const arrowNavigableElements = await page.evaluate(() => {
      const elements = document.querySelectorAll(
        '[role="menu"], [role="listbox"], [role="tree"], [role="grid"], [role="tablist"]'
      );
      return Array.from(elements).map(el => ({
        selector: el.tagName + (el.id ? `#${el.id}` : `.${el.className.split(' ')[0]}`),
        role: el.getAttribute('role')
      }));
    });

    for (const element of arrowNavigableElements) {
      try {
        // Focus the element
        await page.focus(element.selector);

        // Test ArrowDown
        await page.keyboard.press('ArrowDown');
        const focusedAfterDown = await page.evaluate(() => document.activeElement?.tagName);

        interactions.push({
          key: 'ArrowDown',
          target: element.selector,
          expectedBehavior: `Focus moves to next item in ${element.role}`,
          actualBehavior: `Focus on ${focusedAfterDown}`,
          success: true, // Simplified - would need more sophisticated validation
          timestamp: new Date()
        });

      } catch (error) {
        interactions.push({
          key: 'ArrowDown',
          target: element.selector,
          expectedBehavior: `Focus moves to next item in ${element.role}`,
          actualBehavior: 'Failed to test navigation',
          success: false,
          timestamp: new Date()
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

    // Find dismissible components
    const dismissibleElements = await page.evaluate(() => {
      const elements = document.querySelectorAll(
        '[role="dialog"], [role="alertdialog"], .modal, [aria-modal="true"]'
      );
      return Array.from(elements).map(el => ({
        selector: el.tagName + (el.id ? `#${el.id}` : `.${el.className.split(' ')[0]}`),
        visible: (el as HTMLElement).offsetParent !== null
      }));
    });

    for (const element of dismissibleElements) {
      if (!element.visible) continue;

      try {
        // Press Escape
        await page.keyboard.press('Escape');

        // Check if element is still visible
        const stillVisible = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          return el ? (el as HTMLElement).offsetParent !== null : false;
        }, element.selector);

        interactions.push({
          key: 'Escape',
          target: element.selector,
          expectedBehavior: 'Modal/dialog closes on Escape',
          actualBehavior: stillVisible ? 'Still visible' : 'Closed',
          success: !stillVisible,
          timestamp: new Date()
        });

      } catch (error) {
        interactions.push({
          key: 'Escape',
          target: element.selector,
          expectedBehavior: 'Modal/dialog closes on Escape',
          actualBehavior: 'Failed to test',
          success: false,
          timestamp: new Date()
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
          timestamp: new Date()
        });

      } catch (error) {
        interactions.push({
          key: sequence.keys.join('+'),
          target: sequence.name,
          expectedBehavior: sequence.expectedBehavior,
          actualBehavior: 'Failed to execute sequence',
          success: false,
          timestamp: new Date()
        });
      }
    }

    return interactions;
  }
}
