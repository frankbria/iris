/**
 * Accessibility Runner Tests
 *
 * Comprehensive test suite for AccessibilityRunner orchestration module
 */

import { Browser, Page, BrowserContext } from 'playwright';
import { AccessibilityRunner } from '../../src/a11y/a11y-runner';
import { AxeRunner } from '../../src/a11y/axe-integration';
import { KeyboardTester } from '../../src/a11y/keyboard-tester';
import type { KeyboardTestConfig } from '../../src/a11y/keyboard-tester';
import { NavigatedDuringScanError } from '../../src/a11y/scan-navigation';

// Mock Playwright
jest.mock('playwright');

// Mock child modules
jest.mock('../../src/a11y/axe-integration');
jest.mock('../../src/a11y/keyboard-tester');

describe('AccessibilityRunner', () => {
  let mockBrowser: jest.Mocked<Browser>;
  let mockContext: jest.Mocked<BrowserContext>;
  let mockPage: jest.Mocked<Page>;
  let mockAxeRunner: jest.Mocked<AxeRunner>;
  let mockKeyboardTester: jest.Mocked<KeyboardTester>;
  let accessibilityRunner: AccessibilityRunner;

  const defaultConfig = {
    pages: ['/', '/about'],
    axe: {
      rules: {},
      tags: ['wcag2a', 'wcag2aa'],
      include: [],
      exclude: [],
      disableRules: [],
      timeout: 10000,
    },
    keyboard: {
      testFocusOrder: true,
      testTrapDetection: true,
      testArrowKeyNavigation: true,
      testEscapeHandling: true,
      customSequences: [],
    },
    screenReader: {
      testAriaLabels: true,
      testLandmarkNavigation: true,
      testImageAltText: true,
      testHeadingStructure: true,
      simulateScreenReader: true,
    },
    failureThreshold: {
      critical: true,
      serious: true,
      moderate: false,
      minor: false,
    },
    reporting: {
      includePassedTests: true,
      groupByImpact: true,
      includeScreenshots: false,
    },
  };

  beforeEach(() => {
    // Mock Playwright Page
    mockPage = {
      goto: jest.fn().mockResolvedValue(undefined),
      // The document's URL, which the runner reports (#662): the page that was navigated
      // to, unless a test says the page moved on.
      url: jest.fn(() => mockPage.goto.mock.calls.at(-1)?.[0] ?? 'about:blank'),
      evaluate: jest.fn().mockResolvedValue([]),
      // The handle the runner holds the scanned document by (#675): it answers while the
      // page holds that document.
      evaluateHandle: jest.fn().mockResolvedValue({
        evaluate: jest.fn().mockResolvedValue(0),
        dispose: jest.fn().mockResolvedValue(undefined),
      }),
      close: jest.fn().mockResolvedValue(undefined),
      // What installUrlPolicyGuard touches: the runner always installs it (#335).
      context: () => mockContext,
      once: jest.fn(),
      routeWebSocket: jest.fn().mockResolvedValue(undefined),
    } as any;

    // Mock Playwright BrowserContext
    mockContext = {
      newPage: jest.fn().mockResolvedValue(mockPage),
      newCDPSession: jest.fn().mockResolvedValue({
        // The guard asks each page for its target id (#668) and, when the page holds an
        // error page, the browser for the navigation that left it (#677).
        send: jest.fn(async (method: string) =>
          method === 'Page.getFrameTree'
            ? {
                frameTree: {
                  frame: {
                    id: 'page-target',
                    loaderId: 'failed-navigation',
                    url: 'chrome-error://chromewebdata/',
                    unreachableUrl: 'https://unreachable.example/',
                  },
                },
              }
            : { targetInfo: { targetId: 'page-target' } },
        ),
        on: jest.fn(),
      }),
      route: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
      browser: jest.fn().mockReturnValue(null),
      close: jest.fn().mockResolvedValue(undefined),
    } as any;

    // Mock Playwright Browser
    mockBrowser = {
      newContext: jest.fn().mockResolvedValue(mockContext),
      close: jest.fn().mockResolvedValue(undefined),
      // launchBrowser() registers each browser until it disconnects (#442).
      once: jest.fn(),
    } as any;

    // Mock chromium.launch
    const { chromium } = require('playwright');
    chromium.launch = jest.fn().mockResolvedValue(mockBrowser);

    // Mock AxeRunner
    mockAxeRunner = {
      run: jest.fn().mockResolvedValue({
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
          inapplicable: 0,
        },
        testRunner: {
          name: 'axe-core',
          version: '4.8.0',
        },
      }),
      getSeverityCounts: jest.fn().mockReturnValue({
        critical: 0,
        serious: 0,
        moderate: 0,
        minor: 0,
      }),
      checkThreshold: jest.fn().mockReturnValue(true),
    } as any;

    (AxeRunner as jest.MockedClass<typeof AxeRunner>).mockImplementation(() => mockAxeRunner);

    // Mock KeyboardTester
    mockKeyboardTester = {
      run: jest.fn().mockResolvedValue({
        testName: 'keyboard-test',
        passed: true,
        interactions: [],
        focusOrder: [],
        trapTests: [],
      }),
    } as any;

    (KeyboardTester as jest.MockedClass<typeof KeyboardTester>).mockImplementation(
      () => mockKeyboardTester,
    );

    accessibilityRunner = new AccessibilityRunner(defaultConfig);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('run', () => {
    it('should run accessibility tests for all configured pages', async () => {
      const result = await accessibilityRunner.run();

      expect(result).toBeDefined();
      expect(result.summary.pagesTested).toBe(2);
      expect(result.results).toHaveLength(2);
      expect(mockPage.goto).toHaveBeenCalledTimes(2);
      expect(mockAxeRunner.run).toHaveBeenCalledTimes(2);
    });

    it('should launch and close browser', async () => {
      const { chromium } = require('playwright');

      await accessibilityRunner.run();

      // Through the shared hardened factory (issue #331), not a raw launch.
      expect(chromium.launch).toHaveBeenCalledWith(
        expect.objectContaining({ headless: true, chromiumSandbox: true }),
      );
      expect(mockBrowser.close).toHaveBeenCalled();
    });

    it('should close browser even if tests fail', async () => {
      mockAxeRunner.run.mockRejectedValueOnce(new Error('Test failed'));

      // A page that throws is that page's errored result now, not the run's end (#287).
      const result = await accessibilityRunner.run();
      expect(result.results[0].error).toBe('Test failed');
      expect(result.summary.passed).toBe(false);

      expect(mockBrowser.close).toHaveBeenCalled();
    });

    // Codex: an empty reason was falsy, so the reports rendered the page as a pass.
    it('never records an empty reason for a page that failed', async () => {
      mockAxeRunner.run.mockRejectedValueOnce(new Error(''));
      const result = await accessibilityRunner.run();
      expect(result.results[0].error).toBe('Unknown error');
      expect(result.summary).toMatchObject({ passed: false, pagesErrored: 1 });
    });

    it('should still close the browser when the run itself throws', async () => {
      // The report write is outside the per-page isolation: a failure there still throws.
      accessibilityRunner = new AccessibilityRunner({
        ...defaultConfig,
        output: { format: 'yaml' as never },
      });
      await expect(accessibilityRunner.run()).rejects.toThrow(/not yet implemented/);
      expect(mockBrowser.close).toHaveBeenCalled();
    });

    it('should calculate accessibility score based on violations', async () => {
      mockAxeRunner.run.mockResolvedValueOnce({
        testName: 'test',
        url: 'https://example.com',
        timestamp: new Date(),
        passed: false,
        violations: [
          {
            id: 'critical-issue',
            impact: 'critical',
            tags: [],
            description: '',
            help: '',
            helpUrl: '',
            nodes: [],
          },
        ],
        passes: [],
        incomplete: [],
        inapplicable: [],
        summary: {
          total: 1,
          violations: 1,
          passes: 0,
          incomplete: 0,
          inapplicable: 0,
        },
        testRunner: {
          name: 'axe-core',
          version: '4.8.0',
        },
      });

      mockAxeRunner.getSeverityCounts.mockReturnValueOnce({
        critical: 1,
        serious: 0,
        moderate: 0,
        minor: 0,
      });

      const result = await accessibilityRunner.run();

      expect(result.summary.violationsBySeverity.critical).toBe(1);
      expect(result.summary.score).toBeLessThan(100); // Score reduced by violations
    });

    it('should aggregate violations across multiple pages', async () => {
      mockAxeRunner.getSeverityCounts
        .mockReturnValueOnce({ critical: 1, serious: 2, moderate: 0, minor: 0 })
        .mockReturnValueOnce({ critical: 0, serious: 1, moderate: 3, minor: 2 });

      const result = await accessibilityRunner.run();

      expect(result.summary.violationsBySeverity.critical).toBe(1);
      expect(result.summary.violationsBySeverity.serious).toBe(3);
      expect(result.summary.violationsBySeverity.moderate).toBe(3);
      expect(result.summary.violationsBySeverity.minor).toBe(2);
    });

    // #288: the verdict reads the violations against the threshold itself (it no longer asks
    // checkThreshold), so the test supplies real violations at and below it.
    it.each([
      ['critical', false],
      ['minor', true],
    ] as const)(
      'a %s violation under failOn critical makes the page pass=%p',
      async (impact, passed) => {
        mockKeyboardTester.run.mockResolvedValue({
          testName: 'k',
          passed: true,
          interactions: [],
          focusOrder: [],
          trapTests: [],
        });
        // Axe alone: keyboard and screen-reader checks off, so only the threshold decides.
        accessibilityRunner = new AccessibilityRunner({
          ...defaultConfig,
          pages: ['/'],
          failureThreshold: { critical: true },
          keyboard: {
            ...defaultConfig.keyboard,
            testFocusOrder: false,
            testTrapDetection: false,
            testArrowKeyNavigation: false,
            testEscapeHandling: false,
            customSequences: [],
          },
          screenReader: {
            testAriaLabels: false,
            testLandmarkNavigation: false,
            testImageAltText: false,
            testHeadingStructure: false,
            simulateScreenReader: false,
          },
        });
        mockAxeRunner.run.mockResolvedValue({
          testName: 't',
          url: 'https://example.com',
          timestamp: new Date(),
          passed: false,
          violations: [
            { id: 'rule', impact, tags: [], description: 'd', help: 'h', helpUrl: 'u', nodes: [] },
          ],
          passes: [],
          incomplete: [],
          inapplicable: [],
          summary: { total: 1, violations: 1, passes: 0, incomplete: 0, inapplicable: 0 },
          testRunner: { name: 'axe-core', version: '4.8.0' },
        } as any);

        const result = await accessibilityRunner.run();

        expect(result.results[0].passed).toBe(passed);
        expect(result.summary.passed).toBe(passed);
        expect(result.results[0].failureReasons).toEqual(
          passed ? [] : [expect.stringMatching(/^axe: 1 violation/)],
        );
      },
    );

    it('should mark overall test as failed when keyboard tests fail', async () => {
      mockKeyboardTester.run.mockResolvedValue({
        testName: 'keyboard-test',
        passed: false, // Keyboard test failed
        interactions: [],
        focusOrder: [],
        trapTests: [],
      });

      const result = await accessibilityRunner.run();

      expect(result.summary.passed).toBe(false);
      expect(result.summary.keyboardTestsFailed).toBe(2);
    });

    it('should count keyboard test results correctly', async () => {
      mockKeyboardTester.run
        .mockResolvedValueOnce({
          testName: 'keyboard-test-1',
          passed: true,
          interactions: [],
          focusOrder: [],
          trapTests: [],
        })
        .mockResolvedValueOnce({
          testName: 'keyboard-test-2',
          passed: false,
          interactions: [],
          focusOrder: [],
          trapTests: [],
        });

      const result = await accessibilityRunner.run();

      expect(result.summary.keyboardTestsPassed).toBe(1);
      expect(result.summary.keyboardTestsFailed).toBe(1);
    });

    it('should navigate to correct URLs for pages', async () => {
      await accessibilityRunner.run();

      expect(mockPage.goto).toHaveBeenCalledWith('http://localhost:3000/', {
        waitUntil: 'networkidle',
      });
      expect(mockPage.goto).toHaveBeenCalledWith('http://localhost:3000/about', {
        waitUntil: 'networkidle',
      });
    });

    // #662: the response of the navigation asked for is the first page; a page can move on.
    it('hands axe the URL of the document it scans, without fragment or credentials', async () => {
      mockPage.url.mockReturnValue('https://user:pw@example.com/login?next=1#access_token=s3cret');
      accessibilityRunner = new AccessibilityRunner({
        ...defaultConfig,
        pages: ['https://example.com/account'],
      });

      await accessibilityRunner.run();

      expect(mockAxeRunner.run).toHaveBeenCalledWith(
        mockPage,
        expect.any(String),
        'https://example.com/login?next=1',
      );
    });

    it('leaves a data: document URL as it is', async () => {
      const page = 'data:text/html,<h1>hi</h1>#part';
      accessibilityRunner = new AccessibilityRunner({ ...defaultConfig, pages: [page] });

      await accessibilityRunner.run();

      expect(mockAxeRunner.run).toHaveBeenCalledWith(mockPage, expect.any(String), page);
    });

    it('does not scan the error page a failed move leaves behind', async () => {
      mockPage.url.mockReturnValue('chrome-error://chromewebdata/');
      accessibilityRunner = new AccessibilityRunner({
        ...defaultConfig,
        pages: ['https://example.com/account'],
      });

      const result = await accessibilityRunner.run();

      expect(mockAxeRunner.run).not.toHaveBeenCalled();
      expect(result.results[0].error).toBe(
        'https://example.com/account moved on to a page that could not be loaded',
      );
      expect(result.summary.passed).toBe(false);
    });

    describe('a page that moves on during its checks (#669)', () => {
      const first = 'https://example.com/account';
      const second = 'https://example.com/login?next=%2Faccount';
      const scanOf = (keyboard: Partial<KeyboardTestConfig> = {}) =>
        new AccessibilityRunner({
          ...defaultConfig,
          pages: [first],
          keyboard: { ...defaultConfig.keyboard, ...keyboard },
        }).run();
      /** A check during which the page goes from `first` to `to`. */
      const movingTo = <T>(to: string, outcome: () => Promise<T>): (() => Promise<T>) => {
        let url = first;
        mockPage.url.mockImplementation(() => url);
        return () => {
          url = to;
          return outcome();
        };
      };

      it('fails the page, by name, when the axe scan returned a result across the move', async () => {
        const measured = await mockAxeRunner.run(mockPage, 'test', first);
        mockAxeRunner.run.mockImplementation(movingTo(second, () => Promise.resolve(measured)));

        const result = await scanOf();

        expect(result.results[0].error).toBe(
          `The page navigated during the scan: it was at ${first} when the scan began and ` +
            'moved to another page before its checks finished',
        );
        expect(result.results[0].passed).toBe(false);
        expect(result.summary.pagesErrored).toBe(1);
        // Nothing else was measured on the second page.
        expect(mockKeyboardTester.run).not.toHaveBeenCalled();
      });

      it('fails the page, by name, when it loaded again under the same URL (#675)', async () => {
        mockPage.url.mockReturnValue(first);
        const scannedDocument = {
          evaluate: jest.fn().mockResolvedValue(0),
          dispose: jest.fn().mockResolvedValue(undefined),
        };
        mockPage.evaluateHandle.mockResolvedValue(scannedDocument);
        mockAxeRunner.run.mockImplementation(() => {
          scannedDocument.evaluate.mockRejectedValue(new Error('Execution context was destroyed'));
          return Promise.reject(new Error('Execution context was destroyed'));
        });

        const result = await scanOf();

        expect(result.results[0].error).toBe(
          `The page navigated during the scan: it was at ${first} when the scan began and ` +
            'loaded again before its checks finished',
        );
        expect(mockKeyboardTester.run).not.toHaveBeenCalled();
      });

      it('holds the document a navigation left when one committed as it took hold (#675)', async () => {
        mockPage.url.mockReturnValue(first);
        const held = await mockPage.evaluateHandle('document');
        mockPage.evaluateHandle
          .mockReset()
          .mockRejectedValueOnce(new Error('Execution context was destroyed'))
          .mockResolvedValue(held);

        const result = await scanOf();

        expect(result.results[0].error).toBeUndefined();
        expect(mockPage.evaluateHandle).toHaveBeenCalledTimes(2);
      });

      it('fails the page, by name, when the move destroyed the axe scan', async () => {
        mockAxeRunner.run.mockImplementation(
          movingTo(second, () =>
            Promise.reject(
              new Error('Execution context was destroyed, most likely because of a navigation'),
            ),
          ),
        );

        const result = await scanOf();

        expect(result.results[0].error).toMatch(/^The page navigated during the scan: /);
        expect(result.results[0].error).not.toMatch(/login|Execution context/);
      });

      it('fails the page when it moves on during the screen-reader checks', async () => {
        let url = first;
        mockPage.url.mockImplementation(() => url);
        mockPage.evaluate.mockImplementation(async (script: unknown) => {
          // The screen-reader checks pass functions; the comparison's own call is a string.
          if (typeof script === 'function') url = second;
          return [];
        });

        const result = await scanOf();

        expect(result.results[0].error).toMatch(/^The page navigated during the scan: /);
        expect(mockKeyboardTester.run).not.toHaveBeenCalled();
      });

      it('scans a page that only rewrites its query string and fragment', async () => {
        const measured = await mockAxeRunner.run(mockPage, 'test', first);
        mockAxeRunner.run.mockImplementation(
          movingTo(`${first}?tab=2#section`, () => Promise.resolve(measured)),
        );

        const result = await scanOf();

        expect(result.results[0].error).toBeUndefined();
        expect(mockKeyboardTester.run).toHaveBeenCalledTimes(1);
      });

      it("keeps the scan's own error when the page did not move", async () => {
        mockAxeRunner.run.mockRejectedValue(new Error('axe-core timed out after 30000 ms'));

        const result = await scanOf();

        expect(result.results[0].error).toBe('axe-core timed out after 30000 ms');
      });

      // A dialog whose Escape handler leaves the page passes its keyboard check (#286).
      it('does not fail a page that a key press of the keyboard checks moved on', async () => {
        const walked = await mockKeyboardTester.run(mockPage, 'test');
        mockKeyboardTester.run.mockImplementation(
          movingTo(second, () => {
            mockKeyboardTester.navigatedByKey = true;
            return Promise.resolve(walked);
          }),
        );

        const result = await scanOf();

        expect(result.results[0].error).toBeUndefined();
        expect(result.results[0].keyboardResult).toBe(walked);
      });

      it('does not fail a page that moved while custom key sequences ran', async () => {
        const walked = await mockKeyboardTester.run(mockPage, 'test');
        mockKeyboardTester.run.mockImplementation(movingTo(second, () => Promise.resolve(walked)));

        const result = await scanOf({
          customSequences: [{ name: 'open', keys: ['Enter'], expectedBehavior: 'opens' }],
        });

        expect(result.results[0].error).toBeUndefined();
      });

      // The tester stops before its Escape check goes back to the start page (#679).
      it('fails a page the tester saw move by itself, though custom key sequences are set (#679)', async () => {
        mockKeyboardTester.run.mockImplementation(
          movingTo(second, () => {
            mockKeyboardTester.movedByItself = true;
            return Promise.reject(
              new Error(
                'Keyboard testing failed: The page moved on by itself before the Escape check',
              ),
            );
          }),
        );

        const result = await scanOf({
          customSequences: [{ name: 'open', keys: ['Enter'], expectedBehavior: 'opens' }],
        });

        expect(result.results[0].error).toBe(
          `The page navigated during the scan: it was at ${first} when the scan began and ` +
            'moved to another page before its checks finished',
        );
        // The tester judges by the document the runner scanned, not one it took later.
        expect(mockKeyboardTester.run).toHaveBeenCalledWith(
          mockPage,
          expect.any(String),
          expect.objectContaining({ url: first }),
        );
      });

      // The page was back at the scanned path when the hold read it: the tester's own
      // error names the move (#683).
      it('fails by name a page the tester saw move, though it is back where it was', async () => {
        mockKeyboardTester.run.mockImplementation(() => {
          mockKeyboardTester.movedByItself = true;
          return Promise.reject(new NavigatedDuringScanError(first, false));
        });

        const result = await scanOf();

        expect(result.results[0].error).toBe(
          `The page navigated during the scan: it was at ${first} when the scan began and ` +
            'moved to another page before its checks finished',
        );
      });

      describe('the document the keyboard checks loaded again (#683)', () => {
        const reloadedInto = () => ({
          url: first,
          replaced: jest.fn().mockResolvedValue(false),
          release: jest.fn().mockResolvedValue(undefined),
        });

        it('is let go of once the hold has asked it', async () => {
          const reloaded = reloadedInto();
          const walked = await mockKeyboardTester.run(mockPage, 'test');
          mockKeyboardTester.run.mockImplementation(async () => {
            mockKeyboardTester.reloadedInto = reloaded;
            return walked;
          });

          const result = await scanOf();

          expect(result.results[0].error).toBeUndefined();
          expect(reloaded.release).toHaveBeenCalledTimes(1);
          expect(reloaded.replaced.mock.invocationCallOrder[0]).toBeLessThan(
            reloaded.release.mock.invocationCallOrder[0],
          );
        });

        it('is let go of when the keyboard checks failed too', async () => {
          const reloaded = reloadedInto();
          mockKeyboardTester.run.mockImplementation(async () => {
            mockKeyboardTester.reloadedInto = reloaded;
            throw new Error('Keyboard testing failed: no');
          });

          const result = await scanOf();

          expect(result.results[0].error).toBe('Keyboard testing failed: no');
          expect(reloaded.release).toHaveBeenCalledTimes(1);
        });
      });

      it('fails a page that moved on by itself during the keyboard checks', async () => {
        const walked = await mockKeyboardTester.run(mockPage, 'test');
        mockKeyboardTester.run.mockImplementation(movingTo(second, () => Promise.resolve(walked)));

        const result = await scanOf();

        expect(result.results[0].error).toMatch(/^The page navigated during the scan: /);
        expect(result.results[0].keyboardResult).toBeUndefined();
      });

      it('fails the page, by name, when such a move destroyed the keyboard checks', async () => {
        mockKeyboardTester.run.mockImplementation(
          movingTo(second, () =>
            Promise.reject(new Error('Keyboard testing failed: Execution context was destroyed')),
          ),
        );

        const result = await scanOf();

        expect(result.results[0].error).toMatch(/^The page navigated during the scan: /);
      });

      // #662's words for it: what a refused or failed move leaves is Chromium's error page.
      it('says a move that could not be loaded was one, not just that the page navigated', async () => {
        const measured = await mockAxeRunner.run(mockPage, 'test', first);
        mockAxeRunner.run.mockImplementation(
          movingTo('chrome-error://chromewebdata/', () => Promise.resolve(measured)),
        );

        const result = await scanOf();

        expect(result.results[0].error).toBe(
          `${first} moved on to a page that could not be loaded`,
        );
      });

      it('runs the checks that only read the page before the ones that press keys', async () => {
        const order: string[] = [];
        const measured = await mockAxeRunner.run(mockPage, 'test', first);
        mockAxeRunner.run.mockImplementation(async () => {
          order.push('axe');
          return measured;
        });
        mockPage.evaluate.mockImplementation(async (script: unknown) => {
          if (typeof script === 'function' && order.at(-1) !== 'screen reader') {
            order.push('screen reader');
          }
          return [];
        });
        mockKeyboardTester.run.mockImplementation(async () => {
          order.push('keyboard');
          return {
            testName: 'keyboard-test',
            passed: true,
            interactions: [],
            focusOrder: [],
            trapTests: [],
          };
        });

        await scanOf();

        expect(order).toEqual(['axe', 'screen reader', 'keyboard']);
      });
    });

    it('should handle absolute URLs', async () => {
      const customConfig = {
        ...defaultConfig,
        pages: ['https://example.com/page1', 'https://example.com/page2'],
      };
      accessibilityRunner = new AccessibilityRunner(customConfig);

      await accessibilityRunner.run();

      expect(mockPage.goto).toHaveBeenCalledWith('https://example.com/page1', {
        waitUntil: 'networkidle',
      });
      expect(mockPage.goto).toHaveBeenCalledWith('https://example.com/page2', {
        waitUntil: 'networkidle',
      });
    });

    it('should resolve relative pages against a configured baseURL', async () => {
      const customConfig = {
        ...defaultConfig,
        baseURL: 'https://staging.example.com',
        pages: ['/', '/about'],
      };
      accessibilityRunner = new AccessibilityRunner(customConfig);

      await accessibilityRunner.run();

      expect(mockPage.goto).toHaveBeenCalledWith('https://staging.example.com/', {
        waitUntil: 'networkidle',
      });
      expect(mockPage.goto).toHaveBeenCalledWith('https://staging.example.com/about', {
        waitUntil: 'networkidle',
      });
    });

    it('should pass absolute URLs through unchanged even when baseURL is set', async () => {
      const customConfig = {
        ...defaultConfig,
        baseURL: 'https://staging.example.com',
        pages: ['https://example.com/page1'],
      };
      accessibilityRunner = new AccessibilityRunner(customConfig);

      await accessibilityRunner.run();

      expect(mockPage.goto).toHaveBeenCalledWith('https://example.com/page1', {
        waitUntil: 'networkidle',
      });
    });

    it('should not double up slashes when baseURL has a trailing slash', async () => {
      const customConfig = {
        ...defaultConfig,
        baseURL: 'https://staging.example.com/',
        pages: ['/about'],
      };
      accessibilityRunner = new AccessibilityRunner(customConfig);

      await accessibilityRunner.run();

      expect(mockPage.goto).toHaveBeenCalledWith('https://staging.example.com/about', {
        waitUntil: 'networkidle',
      });
    });

    it('should include duration in results', async () => {
      const result = await accessibilityRunner.run();

      expect(result.duration).toBeGreaterThanOrEqual(0); // Can be 0 in fast mock execution
      expect(typeof result.duration).toBe('number');
    });
  });

  describe('keyboard testing integration', () => {
    it('should run keyboard tests when any keyboard option is enabled', async () => {
      const result = await accessibilityRunner.run();

      expect(mockKeyboardTester.run).toHaveBeenCalledTimes(2);
      expect(result.results[0].keyboardResult).toBeDefined();
    });

    it('should skip keyboard tests when all options are disabled', async () => {
      const configNoKeyboard = {
        ...defaultConfig,
        keyboard: {
          testFocusOrder: false,
          testTrapDetection: false,
          testArrowKeyNavigation: false,
          testEscapeHandling: false,
          customSequences: [],
        },
      };
      accessibilityRunner = new AccessibilityRunner(configNoKeyboard);

      const result = await accessibilityRunner.run();

      expect(mockKeyboardTester.run).not.toHaveBeenCalled();
      expect(result.results[0].keyboardResult).toBeUndefined();
    });
  });

  describe('screen reader testing', () => {
    it('should run screen reader tests when enabled', async () => {
      // Mock screen reader test data
      mockPage.evaluate.mockImplementation((fn: any) => {
        if (fn.toString().includes('aria-label')) {
          return Promise.resolve([
            {
              element: 'BUTTON',
              expectedText: 'Submit',
              actualText: 'Submit',
              role: 'button',
              properties: { 'aria-label': 'Submit' },
              success: true,
            },
          ]);
        }
        if (fn.toString().includes('landmarkElements')) {
          return Promise.resolve([
            {
              type: 'main',
              label: 'Main content',
              element: 'MAIN',
              level: undefined,
            },
          ]);
        }
        if (fn.toString().includes('headingElements')) {
          return Promise.resolve([
            { level: 1, text: 'Title', element: 'H1' },
            { level: 2, text: 'Subtitle', element: 'H2' },
          ]);
        }
        return Promise.resolve([]);
      });

      const result = await accessibilityRunner.run();

      expect(result.results[0].screenReaderResult).toBeDefined();
      expect(result.results[0].screenReaderResult?.announcements).toHaveLength(1);
      expect(result.results[0].screenReaderResult?.landmarkStructure).toHaveLength(1);
      expect(result.results[0].screenReaderResult?.headingStructure).toHaveLength(2);
    });

    it('should skip screen reader tests when disabled', async () => {
      const configNoScreenReader = {
        ...defaultConfig,
        screenReader: {
          testAriaLabels: false,
          testLandmarkNavigation: false,
          testImageAltText: false,
          testHeadingStructure: false,
          simulateScreenReader: false,
        },
      };
      accessibilityRunner = new AccessibilityRunner(configNoScreenReader);

      const result = await accessibilityRunner.run();

      expect(result.results[0].screenReaderResult).toBeUndefined();
    });

    it('should fail when heading hierarchy is invalid', async () => {
      mockPage.evaluate.mockImplementation((fn: any) => {
        if (fn.toString().includes('headingElements')) {
          return Promise.resolve([
            { level: 1, text: 'Title', element: 'H1' },
            { level: 3, text: 'Subtitle', element: 'H3' }, // Skipped H2
          ]);
        }
        if (fn.toString().includes('landmarkElements')) {
          return Promise.resolve([
            { type: 'main', label: 'Main', element: 'MAIN', level: undefined },
          ]);
        }
        return Promise.resolve([]);
      });

      const result = await accessibilityRunner.run();

      expect(result.results[0].screenReaderResult?.passed).toBe(false);
    });

    it('should pass when heading hierarchy is valid', async () => {
      mockPage.evaluate.mockImplementation((fn: any) => {
        if (fn.toString().includes('headingElements')) {
          return Promise.resolve([
            { level: 1, text: 'Title', element: 'H1' },
            { level: 2, text: 'Subtitle', element: 'H2' },
            { level: 3, text: 'Section', element: 'H3' },
          ]);
        }
        if (fn.toString().includes('landmarkElements')) {
          return Promise.resolve([
            { type: 'main', label: 'Main', element: 'MAIN', level: undefined },
          ]);
        }
        return Promise.resolve([]);
      });

      const result = await accessibilityRunner.run();

      expect(result.results[0].screenReaderResult?.passed).toBe(true);
    });

    it('should report a violation for an image missing alt text', async () => {
      mockPage.evaluate.mockImplementation((fn: any) => {
        if (fn.toString().includes('imageElements')) {
          return Promise.resolve([
            {
              element: 'IMG#hero',
              alt: undefined,
              hasAlt: false,
              isDecorative: false,
              success: false,
            },
            { element: 'IMG#decor', alt: '', hasAlt: true, isDecorative: true, success: true },
            {
              element: 'IMG#logo',
              alt: 'Company logo',
              hasAlt: true,
              isDecorative: false,
              success: true,
            },
          ]);
        }
        if (fn.toString().includes('landmarkElements')) {
          return Promise.resolve([
            { type: 'main', label: 'Main', element: 'MAIN', level: undefined },
          ]);
        }
        return Promise.resolve([]);
      });

      const result = await accessibilityRunner.run();
      const sr = result.results[0].screenReaderResult;

      expect(sr?.imageAltResults).toHaveLength(3);
      expect(sr?.imageAltResults?.find((i) => i.element === 'IMG#hero')?.success).toBe(false);
      expect(sr?.passed).toBe(false);
    });

    it('should pass when all images have valid alt text or are decorative', async () => {
      mockPage.evaluate.mockImplementation((fn: any) => {
        if (fn.toString().includes('imageElements')) {
          return Promise.resolve([
            { element: 'IMG#decor', alt: '', hasAlt: true, isDecorative: true, success: true },
            {
              element: 'IMG#logo',
              alt: 'Company logo',
              hasAlt: true,
              isDecorative: false,
              success: true,
            },
          ]);
        }
        if (fn.toString().includes('landmarkElements')) {
          return Promise.resolve([
            { type: 'main', label: 'Main', element: 'MAIN', level: undefined },
          ]);
        }
        return Promise.resolve([]);
      });

      const result = await accessibilityRunner.run();
      const sr = result.results[0].screenReaderResult;

      expect(sr?.imageAltResults).toHaveLength(2);
      expect(sr?.imageAltResults?.every((i) => i.success)).toBe(true);
      expect(sr?.passed).toBe(true);
    });
  });

  describe('report generation', () => {
    it('should generate JSON report when configured', async () => {
      const fs = require('fs');
      jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

      const configWithReport = {
        ...defaultConfig,
        output: {
          format: 'json' as const,
          path: './test-report.json',
        },
      };
      accessibilityRunner = new AccessibilityRunner(configWithReport);

      const result = await accessibilityRunner.run();

      expect(result.reportPath).toBe('./test-report.json');
      expect(fs.writeFileSync).toHaveBeenCalledWith('./test-report.json', expect.any(String));

      fs.writeFileSync.mockRestore();
    });

    it('should not generate report when output not configured', async () => {
      const fs = require('fs');
      jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

      const result = await accessibilityRunner.run();

      expect(result.reportPath).toBeUndefined();
      expect(fs.writeFileSync).not.toHaveBeenCalled();

      fs.writeFileSync.mockRestore();
    });

    it('should generate an HTML report on the default path without throwing', async () => {
      const fs = require('fs');
      let written = '';
      jest.spyOn(fs, 'writeFileSync').mockImplementation((...args: unknown[]) => {
        written = args[1] as string;
      });

      const configWithHtmlReport = {
        ...defaultConfig,
        output: {
          format: 'html' as const,
          path: './report.html',
        },
      };
      accessibilityRunner = new AccessibilityRunner(configWithHtmlReport);

      const result = await accessibilityRunner.run();

      expect(result.reportPath).toBe('./report.html');
      expect(fs.writeFileSync).toHaveBeenCalledWith('./report.html', expect.any(String));
      expect(written).toContain('<!DOCTYPE html>');
      expect(written).toContain('Accessibility Report');

      fs.writeFileSync.mockRestore();
    });

    it('should render violations and escape HTML in the HTML report', async () => {
      const fs = require('fs');
      let written = '';
      jest.spyOn(fs, 'writeFileSync').mockImplementation((...args: unknown[]) => {
        written = args[1] as string;
      });
      mockAxeRunner.run.mockResolvedValue({
        testName: 'home',
        url: 'https://example.com',
        timestamp: new Date(),
        passed: false,
        violations: [
          {
            id: 'image-alt',
            impact: 'critical',
            tags: ['wcag2a'],
            description: 'Images must have alternate text',
            help: 'Image needs alt',
            helpUrl: 'https://example.com/rules/image-alt',
            nodes: [{ target: ['img'], html: '<img src="x">', failureSummary: 'Fix it' }],
          },
        ],
        passes: [],
        incomplete: [],
        inapplicable: [],
        summary: { total: 1, violations: 1, passes: 0, incomplete: 0, inapplicable: 0 },
        testRunner: { name: 'axe-core', version: '4.8.0' },
      } as any);

      accessibilityRunner = new AccessibilityRunner({
        ...defaultConfig,
        pages: ['/'],
        output: { format: 'html' as const, path: './report.html' },
      });
      await accessibilityRunner.run();

      expect(written).toContain('image-alt');
      // Raw HTML snippet from the violation node must be escaped, not injected.
      expect(written).toContain('&lt;img src=&quot;x&quot;&gt;');
      expect(written).not.toContain('<img src="x">');

      fs.writeFileSync.mockRestore();
    });

    it('should generate a JUnit XML report', async () => {
      const fs = require('fs');
      let written = '';
      jest.spyOn(fs, 'writeFileSync').mockImplementation((...args: unknown[]) => {
        written = args[1] as string;
      });
      mockAxeRunner.run.mockResolvedValue({
        testName: 'home',
        url: 'https://example.com',
        timestamp: new Date(),
        passed: false,
        violations: [
          {
            id: 'color-contrast',
            impact: 'serious',
            tags: ['wcag2aa'],
            description: 'Elements must have sufficient color contrast',
            help: 'Fix contrast',
            helpUrl: 'https://example.com/rules/color-contrast',
            nodes: [{ target: ['.btn'], html: '<button>Go</button>' }],
          },
        ],
        passes: [],
        incomplete: [],
        inapplicable: [],
        summary: { total: 1, violations: 1, passes: 0, incomplete: 0, inapplicable: 0 },
        testRunner: { name: 'axe-core', version: '4.8.0' },
      } as any);

      accessibilityRunner = new AccessibilityRunner({
        ...defaultConfig,
        pages: ['/'],
        output: { format: 'junit' as const, path: './report.xml' },
      });
      const result = await accessibilityRunner.run();

      expect(result.reportPath).toBe('./report.xml');
      expect(written).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(written).toContain('<testsuites');
      expect(written).toContain('<testcase');
      expect(written).toContain('<failure');
      expect(written).toContain('color-contrast');

      fs.writeFileSync.mockRestore();
    });

    it('should set the JUnit root tests count to the number of emitted testcases', async () => {
      const fs = require('fs');
      let written = '';
      jest.spyOn(fs, 'writeFileSync').mockImplementation((...args: unknown[]) => {
        written = args[1] as string;
      });
      // Two violations on a single page => two <testcase> elements.
      mockAxeRunner.run.mockResolvedValue({
        testName: 'home',
        url: 'https://example.com',
        timestamp: new Date(),
        passed: false,
        violations: [
          {
            id: 'image-alt',
            impact: 'critical',
            tags: [],
            description: 'd',
            help: 'h',
            helpUrl: 'u',
            nodes: [],
          },
          {
            id: 'button-name',
            impact: 'critical',
            tags: [],
            description: 'd',
            help: 'h',
            helpUrl: 'u',
            nodes: [],
          },
        ],
        passes: [],
        incomplete: [],
        inapplicable: [],
        summary: { total: 2, violations: 2, passes: 0, incomplete: 0, inapplicable: 0 },
        testRunner: { name: 'axe-core', version: '4.8.0' },
      } as any);

      mockAxeRunner.getSeverityCounts.mockReturnValue({
        critical: 2,
        serious: 0,
        moderate: 0,
        minor: 0,
      });

      accessibilityRunner = new AccessibilityRunner({
        ...defaultConfig,
        pages: ['/'],
        output: { format: 'junit' as const, path: './report.xml' },
      });
      await accessibilityRunner.run();

      // The root counts are the emitted testcases and failures (#288: one testcase per check
      // per page, axe failing only at the threshold), never fewer tests than failures.
      const root = written.match(/<testsuites [^>]*tests="(\d+)" failures="(\d+)"/)!;
      expect(Number(root[1])).toBe((written.match(/<testcase /g) ?? []).length);
      expect(Number(root[2])).toBe((written.match(/<failure /g) ?? []).length);
      expect(Number(root[2])).toBeGreaterThanOrEqual(1); // the two critical violations

      fs.writeFileSync.mockRestore();
    });
  });

  describe('accessibility score calculation', () => {
    it('should return 100 for perfect accessibility', async () => {
      mockAxeRunner.getSeverityCounts.mockReturnValue({
        critical: 0,
        serious: 0,
        moderate: 0,
        minor: 0,
      });

      const result = await accessibilityRunner.run();

      expect(result.summary.score).toBe(100);
    });

    it('should heavily penalize critical violations', async () => {
      mockAxeRunner.getSeverityCounts.mockReturnValue({
        critical: 1,
        serious: 0,
        moderate: 0,
        minor: 0,
      });

      const result = await accessibilityRunner.run();

      expect(result.summary.score).toBeLessThan(90); // Critical reduces score significantly
    });

    it('should calculate weighted score across multiple severity levels', async () => {
      mockAxeRunner.getSeverityCounts
        .mockReturnValueOnce({ critical: 0, serious: 2, moderate: 3, minor: 5 })
        .mockReturnValueOnce({ critical: 0, serious: 1, moderate: 2, minor: 3 });

      const result = await accessibilityRunner.run();

      expect(result.summary.score).toBeGreaterThan(0);
      expect(result.summary.score).toBeLessThan(100);
    });
  });
});
