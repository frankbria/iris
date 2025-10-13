/**
 * Axe Integration Tests
 *
 * Comprehensive test suite for axe-core integration module
 */

import { Page } from 'playwright';
import { AxeRunner } from '../../src/a11y/axe-integration';
import type { A11yResult } from '../../src/a11y/types';

// Mock @axe-core/playwright
jest.mock('@axe-core/playwright');

describe('AxeRunner', () => {
  let mockPage: jest.Mocked<Page>;
  let axeRunner: AxeRunner;

  const defaultConfig = {
    rules: {},
    tags: ['wcag2a', 'wcag2aa'],
    include: [],
    exclude: [],
    disableRules: [],
    timeout: 10000
  };

  beforeEach(() => {
    // Create mock Playwright page
    mockPage = {
      evaluate: jest.fn(),
      goto: jest.fn(),
      waitForLoadState: jest.fn(),
      context: jest.fn(),
    } as any;

    axeRunner = new AxeRunner(defaultConfig);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('run', () => {
    it('should run axe-core analysis and return results', async () => {
      const mockAxeResults = {
        violations: [
          {
            id: 'color-contrast',
            impact: 'serious',
            tags: ['wcag2aa', 'wcag143'],
            description: 'Elements must have sufficient color contrast',
            help: 'Ensure contrast is at least 4.5:1',
            helpUrl: 'https://dequeuniversity.com/rules/axe/4.6/color-contrast',
            nodes: [
              {
                target: ['.low-contrast'],
                html: '<span class="low-contrast">Text</span>',
                failureSummary: 'Fix color contrast',
                element: 'span'
              }
            ]
          }
        ],
        passes: [
          {
            id: 'heading-order',
            description: 'Headings are in a logical order',
            nodes: [
              {
                target: ['h1'],
                html: '<h1>Title</h1>'
              }
            ]
          }
        ],
        incomplete: [],
        inapplicable: [
          {
            id: 'frame-title',
            description: 'Frames must have title attribute'
          }
        ],
        testEngine: {
          name: 'axe-core',
          version: '4.8.0'
        }
      };

      // Mock AxeBuilder
      const { default: AxeBuilder } = require('@axe-core/playwright');
      const mockAxeBuilder = {
        withTags: jest.fn().mockReturnThis(),
        disableRules: jest.fn().mockReturnThis(),
        analyze: jest.fn().mockResolvedValue(mockAxeResults)
      };
      AxeBuilder.mockImplementation(() => mockAxeBuilder);

      const result = await axeRunner.run(mockPage, 'homepage', 'https://example.com');

      expect(result).toBeDefined();
      expect(result.testName).toBe('homepage');
      expect(result.url).toBe('https://example.com');
      expect(result.passed).toBe(false); // Has violations
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].id).toBe('color-contrast');
      expect(result.violations[0].impact).toBe('serious');
      expect(result.passes).toHaveLength(1);
      expect(result.summary.violations).toBe(1);
      expect(result.summary.passes).toBe(1);
      expect(result.testRunner.name).toBe('axe-core');
    });

    it('should configure axe with provided tags', async () => {
      const mockAxeResults = {
        violations: [],
        passes: [],
        incomplete: [],
        inapplicable: [],
        testEngine: { name: 'axe-core', version: '4.8.0' }
      };

      const { default: AxeBuilder } = require('@axe-core/playwright');
      const mockAxeBuilder = {
        withTags: jest.fn().mockReturnThis(),
        disableRules: jest.fn().mockReturnThis(),
        analyze: jest.fn().mockResolvedValue(mockAxeResults)
      };
      AxeBuilder.mockImplementation(() => mockAxeBuilder);

      await axeRunner.run(mockPage, 'test', 'https://example.com');

      expect(mockAxeBuilder.withTags).toHaveBeenCalledWith(['wcag2a', 'wcag2aa']);
    });

    it('should disable specified rules', async () => {
      const configWithDisabledRules = {
        ...defaultConfig,
        disableRules: ['color-contrast', 'link-name']
      };
      axeRunner = new AxeRunner(configWithDisabledRules);

      const mockAxeResults = {
        violations: [],
        passes: [],
        incomplete: [],
        inapplicable: [],
        testEngine: { name: 'axe-core', version: '4.8.0' }
      };

      const { default: AxeBuilder } = require('@axe-core/playwright');
      const mockAxeBuilder = {
        withTags: jest.fn().mockReturnThis(),
        disableRules: jest.fn().mockReturnThis(),
        analyze: jest.fn().mockResolvedValue(mockAxeResults)
      };
      AxeBuilder.mockImplementation(() => mockAxeBuilder);

      await axeRunner.run(mockPage, 'test', 'https://example.com');

      expect(mockAxeBuilder.disableRules).toHaveBeenCalledWith(['color-contrast', 'link-name']);
    });

    it('should handle multiple violations with different impacts', async () => {
      const mockAxeResults = {
        violations: [
          {
            id: 'critical-issue',
            impact: 'critical',
            tags: ['wcag2a'],
            description: 'Critical accessibility issue',
            help: 'Fix critical issue',
            helpUrl: 'https://example.com/critical',
            nodes: [{ target: ['.critical'], html: '<div class="critical"></div>' }]
          },
          {
            id: 'moderate-issue',
            impact: 'moderate',
            tags: ['wcag2aa'],
            description: 'Moderate accessibility issue',
            help: 'Fix moderate issue',
            helpUrl: 'https://example.com/moderate',
            nodes: [{ target: ['.moderate'], html: '<div class="moderate"></div>' }]
          }
        ],
        passes: [],
        incomplete: [],
        inapplicable: [],
        testEngine: { name: 'axe-core', version: '4.8.0' }
      };

      const { default: AxeBuilder } = require('@axe-core/playwright');
      const mockAxeBuilder = {
        withTags: jest.fn().mockReturnThis(),
        disableRules: jest.fn().mockReturnThis(),
        analyze: jest.fn().mockResolvedValue(mockAxeResults)
      };
      AxeBuilder.mockImplementation(() => mockAxeBuilder);

      const result = await axeRunner.run(mockPage, 'test', 'https://example.com');

      expect(result.violations).toHaveLength(2);
      expect(result.violations[0].impact).toBe('critical');
      expect(result.violations[1].impact).toBe('moderate');
      expect(result.passed).toBe(false);
    });

    it('should mark test as passed when no violations', async () => {
      const mockAxeResults = {
        violations: [],
        passes: [
          {
            id: 'all-pass',
            description: 'All tests pass',
            nodes: [{ target: ['body'], html: '<body></body>' }]
          }
        ],
        incomplete: [],
        inapplicable: [],
        testEngine: { name: 'axe-core', version: '4.8.0' }
      };

      const { default: AxeBuilder } = require('@axe-core/playwright');
      const mockAxeBuilder = {
        withTags: jest.fn().mockReturnThis(),
        disableRules: jest.fn().mockReturnThis(),
        analyze: jest.fn().mockResolvedValue(mockAxeResults)
      };
      AxeBuilder.mockImplementation(() => mockAxeBuilder);

      const result = await axeRunner.run(mockPage, 'test', 'https://example.com');

      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
      expect(result.summary.violations).toBe(0);
    });

    it('should handle axe-core execution errors', async () => {
      const { default: AxeBuilder } = require('@axe-core/playwright');
      const mockAxeBuilder = {
        withTags: jest.fn().mockReturnThis(),
        disableRules: jest.fn().mockReturnThis(),
        analyze: jest.fn().mockRejectedValue(new Error('Axe analysis failed'))
      };
      AxeBuilder.mockImplementation(() => mockAxeBuilder);

      await expect(axeRunner.run(mockPage, 'test', 'https://example.com'))
        .rejects.toThrow('Axe-core execution failed: Axe analysis failed');
    });

    it('should include timestamp in results', async () => {
      const mockAxeResults = {
        violations: [],
        passes: [],
        incomplete: [],
        inapplicable: [],
        testEngine: { name: 'axe-core', version: '4.8.0' }
      };

      const { default: AxeBuilder } = require('@axe-core/playwright');
      const mockAxeBuilder = {
        withTags: jest.fn().mockReturnThis(),
        disableRules: jest.fn().mockReturnThis(),
        analyze: jest.fn().mockResolvedValue(mockAxeResults)
      };
      AxeBuilder.mockImplementation(() => mockAxeBuilder);

      const beforeTest = new Date();
      const result = await axeRunner.run(mockPage, 'test', 'https://example.com');
      const afterTest = new Date();

      expect(result.timestamp).toBeInstanceOf(Date);
      expect(result.timestamp.getTime()).toBeGreaterThanOrEqual(beforeTest.getTime());
      expect(result.timestamp.getTime()).toBeLessThanOrEqual(afterTest.getTime());
    });
  });

  describe('runOnElement', () => {
    it('should run axe-core on specific element', async () => {
      const mockAxeResults = {
        violations: [
          {
            id: 'button-name',
            impact: 'critical',
            tags: ['wcag2a'],
            description: 'Buttons must have discernible text',
            help: 'Add text to button',
            helpUrl: 'https://example.com/button-name',
            nodes: [{ target: ['#submit-btn'], html: '<button id="submit-btn"></button>' }]
          }
        ],
        testEngine: { name: 'axe-core', version: '4.8.0' }
      };

      const { default: AxeBuilder } = require('@axe-core/playwright');
      const mockAxeBuilder = {
        include: jest.fn().mockReturnThis(),
        withTags: jest.fn().mockReturnThis(),
        analyze: jest.fn().mockResolvedValue(mockAxeResults)
      };
      AxeBuilder.mockImplementation(() => mockAxeBuilder);

      const result = await axeRunner.runOnElement(mockPage, '#submit-btn', 'button-test', 'https://example.com');

      expect(mockAxeBuilder.include).toHaveBeenCalledWith('#submit-btn');
      expect(result.testName).toBe('button-test_#submit-btn');
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].id).toBe('button-name');
    });

    it('should handle element-specific errors', async () => {
      const { default: AxeBuilder } = require('@axe-core/playwright');
      const mockAxeBuilder = {
        include: jest.fn().mockReturnThis(),
        withTags: jest.fn().mockReturnThis(),
        analyze: jest.fn().mockRejectedValue(new Error('Element not found'))
      };
      AxeBuilder.mockImplementation(() => mockAxeBuilder);

      await expect(axeRunner.runOnElement(mockPage, '#missing', 'test', 'https://example.com'))
        .rejects.toThrow('Axe-core element scan failed: Element not found');
    });
  });

  describe('getSeverityCounts', () => {
    it('should count violations by severity', () => {
      const result: A11yResult = {
        testName: 'test',
        url: 'https://example.com',
        timestamp: new Date(),
        passed: false,
        violations: [
          {
            id: 'critical-1',
            impact: 'critical',
            tags: [],
            description: '',
            help: '',
            helpUrl: '',
            nodes: []
          },
          {
            id: 'critical-2',
            impact: 'critical',
            tags: [],
            description: '',
            help: '',
            helpUrl: '',
            nodes: []
          },
          {
            id: 'serious-1',
            impact: 'serious',
            tags: [],
            description: '',
            help: '',
            helpUrl: '',
            nodes: []
          },
          {
            id: 'moderate-1',
            impact: 'moderate',
            tags: [],
            description: '',
            help: '',
            helpUrl: '',
            nodes: []
          },
          {
            id: 'moderate-2',
            impact: 'moderate',
            tags: [],
            description: '',
            help: '',
            helpUrl: '',
            nodes: []
          },
          {
            id: 'moderate-3',
            impact: 'moderate',
            tags: [],
            description: '',
            help: '',
            helpUrl: '',
            nodes: []
          },
          {
            id: 'minor-1',
            impact: 'minor',
            tags: [],
            description: '',
            help: '',
            helpUrl: '',
            nodes: []
          }
        ],
        passes: [],
        incomplete: [],
        inapplicable: [],
        summary: {
          total: 7,
          violations: 7,
          passes: 0,
          incomplete: 0,
          inapplicable: 0
        },
        testRunner: {
          name: 'axe-core',
          version: '4.8.0'
        }
      };

      const counts = axeRunner.getSeverityCounts(result);

      expect(counts.critical).toBe(2);
      expect(counts.serious).toBe(1);
      expect(counts.moderate).toBe(3);
      expect(counts.minor).toBe(1);
    });

    it('should return zero counts for no violations', () => {
      const result: A11yResult = {
        testName: 'test',
        url: 'https://example.com',
        timestamp: new Date(),
        passed: true,
        violations: [],
        passes: [],
        incomplete: [],
        inapplicable: [],
        summary: {
          total: 0,
          violations: 0,
          passes: 0,
          incomplete: 0,
          inapplicable: 0
        },
        testRunner: {
          name: 'axe-core',
          version: '4.8.0'
        }
      };

      const counts = axeRunner.getSeverityCounts(result);

      expect(counts.critical).toBe(0);
      expect(counts.serious).toBe(0);
      expect(counts.moderate).toBe(0);
      expect(counts.minor).toBe(0);
    });
  });

  describe('checkThreshold', () => {
    const createResultWithViolations = (impacts: Array<'critical' | 'serious' | 'moderate' | 'minor'>): A11yResult => ({
      testName: 'test',
      url: 'https://example.com',
      timestamp: new Date(),
      passed: false,
      violations: impacts.map(impact => ({
        id: `${impact}-violation`,
        impact,
        tags: [],
        description: '',
        help: '',
        helpUrl: '',
        nodes: []
      })),
      passes: [],
      incomplete: [],
      inapplicable: [],
      summary: {
        total: impacts.length,
        violations: impacts.length,
        passes: 0,
        incomplete: 0,
        inapplicable: 0
      },
      testRunner: {
        name: 'axe-core',
        version: '4.8.0'
      }
    });

    it('should fail when critical violations exceed threshold', () => {
      const result = createResultWithViolations(['critical']);
      const threshold = { critical: true, serious: false, moderate: false, minor: false };

      const passed = axeRunner.checkThreshold(result, threshold);

      expect(passed).toBe(false);
    });

    it('should pass when violations do not exceed threshold', () => {
      const result = createResultWithViolations(['moderate', 'minor']);
      const threshold = { critical: true, serious: true, moderate: false, minor: false };

      const passed = axeRunner.checkThreshold(result, threshold);

      expect(passed).toBe(true);
    });

    it('should fail for any violation matching threshold', () => {
      const result = createResultWithViolations(['critical', 'serious', 'moderate']);
      const threshold = { critical: false, serious: true, moderate: false, minor: false };

      const passed = axeRunner.checkThreshold(result, threshold);

      expect(passed).toBe(false);
    });

    it('should pass when no violations', () => {
      const result = createResultWithViolations([]);
      const threshold = { critical: true, serious: true, moderate: true, minor: true };

      const passed = axeRunner.checkThreshold(result, threshold);

      expect(passed).toBe(true);
    });

    it('should handle multiple severity thresholds', () => {
      const result = createResultWithViolations(['minor', 'minor', 'moderate']);
      const threshold = { critical: true, serious: true, moderate: true, minor: false };

      const passed = axeRunner.checkThreshold(result, threshold);

      expect(passed).toBe(false); // moderate is in threshold
    });
  });
});
