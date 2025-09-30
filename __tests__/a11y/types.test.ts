import {
  A11yTestConfigSchema,
  A11yViolationSchema,
  A11yResultSchema,
  KeyboardTestResultSchema,
  ScreenReaderTestResultSchema,
  A11yReportSchema,
  A11yTestError,
  AxeRunnerError,
  KeyboardNavigationError,
  ScreenReaderError
} from '../../src/a11y/types';

describe('Accessibility Testing Types', () => {
  describe('A11yTestConfigSchema', () => {
    it('should validate valid accessibility test configuration', () => {
      const validConfig = {
        testName: 'homepage-a11y',
        url: 'https://example.com',
        selector: 'main',
        rules: {
          wcag2a: true,
          wcag2aa: true,
          wcag2aaa: false,
          section508: false,
          bestPractice: true
        },
        tags: ['wcag2a', 'wcag2aa'],
        excludeRules: ['color-contrast'],
        timeout: 10000
      };

      const result = A11yTestConfigSchema.safeParse(validConfig);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.testName).toBe('homepage-a11y');
        expect(result.data.rules?.wcag2aa).toBe(true);
        expect(result.data.timeout).toBe(10000);
      }
    });

    it('should apply default values for rules and timeout', () => {
      const minimalConfig = {
        testName: 'basic-test',
        url: 'https://example.com'
      };

      const result = A11yTestConfigSchema.safeParse(minimalConfig);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.timeout).toBe(10000);
        // Rules should be optional and use defaults when provided
      }
    });

    it('should reject invalid URL', () => {
      const invalidConfig = {
        testName: 'test',
        url: 'not-a-valid-url'
      };

      const result = A11yTestConfigSchema.safeParse(invalidConfig);
      expect(result.success).toBe(false);
    });

    it('should reject empty test name', () => {
      const invalidConfig = {
        testName: '',
        url: 'https://example.com'
      };

      const result = A11yTestConfigSchema.safeParse(invalidConfig);
      expect(result.success).toBe(false);
    });
  });

  describe('A11yViolationSchema', () => {
    it('should validate accessibility violation', () => {
      const validViolation = {
        id: 'color-contrast',
        impact: 'serious' as const,
        tags: ['wcag2aa', 'wcag143'],
        description: 'Elements must have sufficient color contrast',
        help: 'Ensure the contrast ratio is at least 4.5:1',
        helpUrl: 'https://dequeuniversity.com/rules/axe/4.6/color-contrast',
        nodes: [
          {
            target: ['.low-contrast-text'],
            html: '<span class="low-contrast-text">Text</span>',
            failureSummary: 'Fix this: Element has insufficient color contrast',
            element: 'span'
          }
        ]
      };

      const result = A11yViolationSchema.safeParse(validViolation);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe('color-contrast');
        expect(result.data.impact).toBe('serious');
        expect(result.data.nodes).toHaveLength(1);
      }
    });

    it('should reject invalid impact level', () => {
      const invalidViolation = {
        id: 'test-rule',
        impact: 'invalid-impact',
        tags: ['wcag2a'],
        description: 'Test description',
        help: 'Test help',
        helpUrl: 'https://example.com',
        nodes: []
      };

      const result = A11yViolationSchema.safeParse(invalidViolation);
      expect(result.success).toBe(false);
    });
  });

  describe('A11yResultSchema', () => {
    it('should validate complete accessibility result', () => {
      const validResult = {
        testName: 'homepage-a11y',
        url: 'https://example.com',
        timestamp: new Date(),
        passed: false,
        violations: [
          {
            id: 'color-contrast',
            impact: 'serious' as const,
            tags: ['wcag2aa'],
            description: 'Color contrast issue',
            help: 'Increase contrast',
            helpUrl: 'https://example.com',
            nodes: [{ target: ['.test'], html: '<div class="test"></div>' }]
          }
        ],
        passes: [
          {
            id: 'heading-order',
            description: 'Heading levels should increase by one',
            nodes: [{ target: ['h1'], html: '<h1>Title</h1>' }]
          }
        ],
        incomplete: [],
        inapplicable: [],
        summary: {
          total: 50,
          violations: 1,
          passes: 49,
          incomplete: 0,
          inapplicable: 5
        },
        testRunner: {
          name: 'axe-core',
          version: '4.6.0'
        }
      };

      const result = A11yResultSchema.safeParse(validResult);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.passed).toBe(false);
        expect(result.data.violations).toHaveLength(1);
        expect(result.data.summary.total).toBe(50);
      }
    });
  });

  describe('KeyboardTestResultSchema', () => {
    it('should validate keyboard test result', () => {
      const validResult = {
        testName: 'keyboard-navigation',
        passed: true,
        interactions: [
          {
            key: 'Tab',
            target: 'button',
            expectedBehavior: 'Focus should move to button',
            actualBehavior: 'Focus moved to button',
            success: true,
            timestamp: new Date()
          }
        ],
        focusOrder: [
          {
            element: 'button',
            tabIndex: 0,
            focusable: true,
            visible: true
          }
        ],
        trapTests: [
          {
            container: '.modal',
            trapped: true,
            escapeMethod: 'Escape key'
          }
        ]
      };

      const result = KeyboardTestResultSchema.safeParse(validResult);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.passed).toBe(true);
        expect(result.data.interactions).toHaveLength(1);
        expect(result.data.focusOrder).toHaveLength(1);
      }
    });
  });

  describe('ScreenReaderTestResultSchema', () => {
    it('should validate screen reader test result', () => {
      const validResult = {
        testName: 'screen-reader-test',
        passed: true,
        announcements: [
          {
            element: 'button',
            expectedText: 'Submit button',
            actualText: 'Submit button',
            role: 'button',
            properties: { 'aria-label': 'Submit' },
            success: true
          }
        ],
        landmarkStructure: [
          {
            type: 'main',
            label: 'Main content',
            element: 'main',
            level: 1
          }
        ],
        headingStructure: [
          {
            level: 1,
            text: 'Page Title',
            element: 'h1'
          }
        ]
      };

      const result = ScreenReaderTestResultSchema.safeParse(validResult);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.passed).toBe(true);
        expect(result.data.announcements).toHaveLength(1);
        expect(result.data.landmarkStructure).toHaveLength(1);
      }
    });
  });

  describe('Error Classes', () => {
    it('should create A11yTestError with correct properties', () => {
      const error = new A11yTestError('A11y test failed', 'A11Y_TEST_FAILED', { url: 'test.com' });

      expect(error.name).toBe('A11yTestError');
      expect(error.message).toBe('A11y test failed');
      expect(error.code).toBe('A11Y_TEST_FAILED');
      expect(error.details).toEqual({ url: 'test.com' });
    });

    it('should create AxeRunnerError', () => {
      const error = new AxeRunnerError('Axe runner failed');

      expect(error.code).toBe('AXE_RUNNER_ERROR');
      expect(error instanceof A11yTestError).toBe(true);
    });

    it('should create KeyboardNavigationError', () => {
      const error = new KeyboardNavigationError('Keyboard test failed');

      expect(error.code).toBe('KEYBOARD_NAVIGATION_ERROR');
      expect(error instanceof A11yTestError).toBe(true);
    });

    it('should create ScreenReaderError', () => {
      const error = new ScreenReaderError('Screen reader test failed');

      expect(error.code).toBe('SCREEN_READER_ERROR');
      expect(error instanceof A11yTestError).toBe(true);
    });
  });
});