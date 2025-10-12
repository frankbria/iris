/**
 * Keyboard Tester Tests
 *
 * Comprehensive test suite for keyboard navigation testing module
 */

import { Page } from 'playwright';
import { KeyboardTester } from '../../src/a11y/keyboard-tester';
import type { KeyboardTestResult } from '../../src/a11y/types';

describe('KeyboardTester', () => {
  let mockPage: jest.Mocked<Page>;
  let keyboardTester: KeyboardTester;

  const defaultConfig = {
    testFocusOrder: true,
    testTrapDetection: true,
    testArrowKeyNavigation: true,
    testEscapeHandling: true,
    customSequences: []
  };

  beforeEach(() => {
    // Create mock Playwright page
    mockPage = {
      evaluate: jest.fn(),
      focus: jest.fn(),
      keyboard: {
        press: jest.fn()
      },
      waitForTimeout: jest.fn()
    } as any;

    keyboardTester = new KeyboardTester(defaultConfig);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('run', () => {
    it('should run all keyboard navigation tests when configured', async () => {
      // Mock focus order elements
      mockPage.evaluate.mockImplementation((fn: any) => {
        // First call: testFocusOrder
        if (fn.toString().includes('focusableSelectors')) {
          return Promise.resolve([
            {
              element: 'BUTTON#submit',
              tabIndex: 0,
              focusable: true,
              visible: true,
              tagName: 'BUTTON',
              role: 'button'
            },
            {
              element: 'INPUT#email',
              tabIndex: 0,
              focusable: true,
              visible: true,
              tagName: 'INPUT'
            }
          ]);
        }
        // Second call: testFocusTraps
        if (fn.toString().includes('focus trap')) {
          return Promise.resolve([]);
        }
        // Third call: testArrowKeyNavigation
        if (fn.toString().includes('menu')) {
          return Promise.resolve([]);
        }
        // Fourth call: testEscapeHandling
        if (fn.toString().includes('dialog')) {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });

      const result = await keyboardTester.run(mockPage, 'keyboard-test');

      expect(result).toBeDefined();
      expect(result.testName).toBe('keyboard-test');
      expect(result.passed).toBe(true);
      expect(result.focusOrder).toHaveLength(2);
      expect(result.interactions).toBeDefined();
      expect(result.trapTests).toBeDefined();
    });

    it('should mark test as failed when focus order is invalid', async () => {
      const configWithFocusTest = {
        ...defaultConfig,
        testTrapDetection: false,
        testArrowKeyNavigation: false,
        testEscapeHandling: false
      };
      keyboardTester = new KeyboardTester(configWithFocusTest);

      // Mock invalid focus order (negative tab index on visible element)
      mockPage.evaluate.mockResolvedValue([
        {
          element: 'BUTTON',
          tabIndex: -1,
          focusable: true,
          visible: true,
          tagName: 'BUTTON'
        }
      ]);

      const result = await keyboardTester.run(mockPage, 'invalid-focus');

      expect(result.passed).toBe(false);
      expect(result.interactions.some(i => !i.success)).toBe(true);
    });

    it('should detect focus traps without escape mechanisms', async () => {
      const configWithTrapTest = {
        testFocusOrder: false,
        testTrapDetection: true,
        testArrowKeyNavigation: false,
        testEscapeHandling: false,
        customSequences: []
      };
      keyboardTester = new KeyboardTester(configWithTrapTest);

      mockPage.evaluate.mockImplementation((fn: any) => {
        if (fn.toString().includes('focus trap')) {
          return Promise.resolve([
            {
              container: 'DIV.modal',
              trapped: true,
              escapeMethod: undefined, // No escape mechanism
              firstElement: 'BUTTON',
              lastElement: 'BUTTON'
            }
          ]);
        }
        return Promise.resolve([]);
      });

      const result = await keyboardTester.run(mockPage, 'trap-test');

      expect(result.passed).toBe(false);
      expect(result.trapTests).toHaveLength(1);
      expect(result.trapTests[0].escapeMethod).toBeUndefined();
    });

    it('should pass when focus traps have escape mechanisms', async () => {
      const configWithTrapTest = {
        testFocusOrder: false,
        testTrapDetection: true,
        testArrowKeyNavigation: false,
        testEscapeHandling: false,
        customSequences: []
      };
      keyboardTester = new KeyboardTester(configWithTrapTest);

      mockPage.evaluate.mockImplementation((fn: any) => {
        if (fn.toString().includes('focus trap')) {
          return Promise.resolve([
            {
              container: 'DIV.modal',
              trapped: true,
              escapeMethod: 'Escape or Close button',
              firstElement: 'BUTTON',
              lastElement: 'BUTTON'
            }
          ]);
        }
        return Promise.resolve([]);
      });

      const result = await keyboardTester.run(mockPage, 'trap-test');

      expect(result.passed).toBe(true);
      expect(result.trapTests).toHaveLength(1);
      expect(result.trapTests[0].escapeMethod).toBeDefined();
    });

    it('should test arrow key navigation in menus', async () => {
      const configWithArrowTest = {
        testFocusOrder: false,
        testTrapDetection: false,
        testArrowKeyNavigation: true,
        testEscapeHandling: false,
        customSequences: []
      };
      keyboardTester = new KeyboardTester(configWithArrowTest);

      mockPage.evaluate.mockImplementation((fn: any) => {
        if (fn.toString().includes('menu')) {
          return Promise.resolve([
            {
              selector: 'DIV.menu',
              role: 'menu'
            }
          ]);
        }
        if (fn.toString().includes('activeElement')) {
          return Promise.resolve('BUTTON');
        }
        return Promise.resolve([]);
      });

      const result = await keyboardTester.run(mockPage, 'arrow-test');

      expect(result.interactions.some(i => i.key === 'ArrowDown')).toBe(true);
      expect(mockPage.focus).toHaveBeenCalled();
      expect(mockPage.keyboard.press).toHaveBeenCalledWith('ArrowDown');
    });

    it('should test escape key handling for modals', async () => {
      const configWithEscapeTest = {
        testFocusOrder: false,
        testTrapDetection: false,
        testArrowKeyNavigation: false,
        testEscapeHandling: true,
        customSequences: []
      };
      keyboardTester = new KeyboardTester(configWithEscapeTest);

      mockPage.evaluate.mockImplementation((fn: any, ...args) => {
        if (fn.toString().includes('dialog')) {
          return Promise.resolve([
            {
              selector: 'DIV.modal',
              visible: true
            }
          ]);
        }
        if (fn.toString().includes('offsetParent')) {
          return Promise.resolve(false); // Modal closed after Escape
        }
        return Promise.resolve([]);
      });

      const result = await keyboardTester.run(mockPage, 'escape-test');

      expect(result.interactions.some(i => i.key === 'Escape')).toBe(true);
      expect(result.interactions.some(i => i.key === 'Escape' && i.success)).toBe(true);
    });

    it('should execute custom keyboard sequences', async () => {
      const configWithCustom = {
        testFocusOrder: false,
        testTrapDetection: false,
        testArrowKeyNavigation: false,
        testEscapeHandling: false,
        customSequences: [
          {
            name: 'save-shortcut',
            keys: ['Control', 's'],
            expectedBehavior: 'Save dialog opens',
            validator: '() => document.querySelector(".save-dialog") !== null'
          }
        ]
      };
      keyboardTester = new KeyboardTester(configWithCustom);

      mockPage.evaluate.mockResolvedValue(true); // Validator passes

      const result = await keyboardTester.run(mockPage, 'custom-test');

      expect(result.interactions.some(i => i.target === 'save-shortcut')).toBe(true);
      expect(mockPage.keyboard.press).toHaveBeenCalledWith('Control');
      expect(mockPage.keyboard.press).toHaveBeenCalledWith('s');
      expect(mockPage.waitForTimeout).toHaveBeenCalled();
    });

    it('should handle keyboard testing errors gracefully', async () => {
      mockPage.evaluate.mockRejectedValue(new Error('Page evaluation failed'));

      await expect(keyboardTester.run(mockPage, 'error-test'))
        .rejects.toThrow('Keyboard testing failed: Page evaluation failed');
    });
  });

  describe('focus order validation', () => {
    it('should pass for natural tab order (no manual tabindex)', async () => {
      const configWithFocusOnly = {
        testFocusOrder: true,
        testTrapDetection: false,
        testArrowKeyNavigation: false,
        testEscapeHandling: false,
        customSequences: []
      };
      keyboardTester = new KeyboardTester(configWithFocusOnly);

      mockPage.evaluate.mockResolvedValue([
        { element: 'BUTTON', tabIndex: 0, focusable: true, visible: true, tagName: 'BUTTON' },
        { element: 'INPUT', tabIndex: 0, focusable: true, visible: true, tagName: 'INPUT' },
        { element: 'A', tabIndex: 0, focusable: true, visible: true, tagName: 'A' }
      ]);

      const result = await keyboardTester.run(mockPage, 'natural-order');

      expect(result.passed).toBe(true);
    });

    it('should fail for elements with negative tabindex', async () => {
      const configWithFocusOnly = {
        testFocusOrder: true,
        testTrapDetection: false,
        testArrowKeyNavigation: false,
        testEscapeHandling: false,
        customSequences: []
      };
      keyboardTester = new KeyboardTester(configWithFocusOnly);

      mockPage.evaluate.mockResolvedValue([
        { element: 'BUTTON', tabIndex: 0, focusable: true, visible: true, tagName: 'BUTTON' },
        { element: 'INPUT', tabIndex: -1, focusable: true, visible: true, tagName: 'INPUT' }
      ]);

      const result = await keyboardTester.run(mockPage, 'negative-tabindex');

      expect(result.passed).toBe(false);
    });

    it('should fail for elements with high manual tabindex', async () => {
      const configWithFocusOnly = {
        testFocusOrder: true,
        testTrapDetection: false,
        testArrowKeyNavigation: false,
        testEscapeHandling: false,
        customSequences: []
      };
      keyboardTester = new KeyboardTester(configWithFocusOnly);

      mockPage.evaluate.mockResolvedValue([
        { element: 'BUTTON', tabIndex: 1, focusable: true, visible: true, tagName: 'BUTTON' },
        { element: 'INPUT', tabIndex: 5, focusable: true, visible: true, tagName: 'INPUT' }
      ]);

      const result = await keyboardTester.run(mockPage, 'manual-tabindex');

      expect(result.passed).toBe(false);
    });
  });

  describe('focus trap detection', () => {
    it('should identify modals as focus traps', async () => {
      mockPage.evaluate.mockImplementation((fn: any) => {
        if (fn.toString().includes('focus trap')) {
          return Promise.resolve([
            {
              container: 'DIV[role="dialog"]',
              trapped: true,
              escapeMethod: 'Escape or Close button',
              firstElement: 'BUTTON.close',
              lastElement: 'BUTTON.cancel'
            }
          ]);
        }
        return Promise.resolve([]);
      });

      const result = await keyboardTester.run(mockPage, 'modal-trap');

      expect(result.trapTests).toHaveLength(1);
      expect(result.trapTests[0].container).toContain('dialog');
      expect(result.trapTests[0].trapped).toBe(true);
    });

    it('should detect traps with no focusable elements', async () => {
      mockPage.evaluate.mockImplementation((fn: any) => {
        if (fn.toString().includes('focus trap')) {
          return Promise.resolve([]); // No traps found
        }
        return Promise.resolve([]);
      });

      const result = await keyboardTester.run(mockPage, 'no-traps');

      expect(result.trapTests).toHaveLength(0);
    });
  });

  describe('arrow key navigation', () => {
    it('should detect and test all arrow-navigable components', async () => {
      const configWithArrowTest = {
        testFocusOrder: false,
        testTrapDetection: false,
        testArrowKeyNavigation: true,
        testEscapeHandling: false,
        customSequences: []
      };
      keyboardTester = new KeyboardTester(configWithArrowTest);

      mockPage.evaluate.mockImplementation((fn: any) => {
        if (fn.toString().includes('menu')) {
          return Promise.resolve([
            { selector: 'NAV[role="menu"]', role: 'menu' },
            { selector: 'DIV[role="listbox"]', role: 'listbox' },
            { selector: 'DIV[role="tablist"]', role: 'tablist' }
          ]);
        }
        if (fn.toString().includes('activeElement')) {
          return Promise.resolve('BUTTON');
        }
        return Promise.resolve([]);
      });

      const result = await keyboardTester.run(mockPage, 'arrow-navigation');

      const arrowInteractions = result.interactions.filter(i => i.key === 'ArrowDown');
      expect(arrowInteractions).toHaveLength(3); // One for each component
    });

    it('should handle arrow navigation errors without failing entire test', async () => {
      const configWithArrowTest = {
        testFocusOrder: false,
        testTrapDetection: false,
        testArrowKeyNavigation: true,
        testEscapeHandling: false,
        customSequences: []
      };
      keyboardTester = new KeyboardTester(configWithArrowTest);

      mockPage.evaluate.mockResolvedValueOnce([
        { selector: 'DIV.menu', role: 'menu' }
      ]);
      mockPage.focus.mockRejectedValue(new Error('Element not found'));

      const result = await keyboardTester.run(mockPage, 'arrow-error');

      expect(result.interactions.some(i => i.key === 'ArrowDown' && !i.success)).toBe(true);
    });
  });

  describe('custom sequences', () => {
    it('should execute multi-key sequences in order', async () => {
      const configWithCustom = {
        testFocusOrder: false,
        testTrapDetection: false,
        testArrowKeyNavigation: false,
        testEscapeHandling: false,
        customSequences: [
          {
            name: 'undo',
            keys: ['Control', 'z'],
            expectedBehavior: 'Undo last action'
          }
        ]
      };
      keyboardTester = new KeyboardTester(configWithCustom);

      const result = await keyboardTester.run(mockPage, 'custom-sequence');

      expect(mockPage.keyboard.press).toHaveBeenCalledWith('Control');
      expect(mockPage.keyboard.press).toHaveBeenCalledWith('z');
      expect(result.interactions.some(i => i.key === 'Control+z')).toBe(true);
    });

    it('should validate custom sequences with validators', async () => {
      const configWithCustom = {
        testFocusOrder: false,
        testTrapDetection: false,
        testArrowKeyNavigation: false,
        testEscapeHandling: false,
        customSequences: [
          {
            name: 'search',
            keys: ['Control', 'f'],
            expectedBehavior: 'Search dialog opens',
            validator: '() => document.querySelector(".search-dialog") !== null'
          }
        ]
      };
      keyboardTester = new KeyboardTester(configWithCustom);

      mockPage.evaluate.mockResolvedValue(true); // Validator passes

      const result = await keyboardTester.run(mockPage, 'validated-sequence');

      expect(result.interactions.some(i => i.target === 'search' && i.success)).toBe(true);
    });

    it('should mark sequence as failed when validator fails', async () => {
      const configWithCustom = {
        testFocusOrder: false,
        testTrapDetection: false,
        testArrowKeyNavigation: false,
        testEscapeHandling: false,
        customSequences: [
          {
            name: 'print',
            keys: ['Control', 'p'],
            expectedBehavior: 'Print dialog opens',
            validator: '() => document.querySelector(".print-dialog") !== null'
          }
        ]
      };
      keyboardTester = new KeyboardTester(configWithCustom);

      mockPage.evaluate.mockResolvedValue(false); // Validator fails

      const result = await keyboardTester.run(mockPage, 'failed-validator');

      expect(result.interactions.some(i => i.target === 'print' && !i.success)).toBe(true);
      expect(result.passed).toBe(false);
    });
  });
});
