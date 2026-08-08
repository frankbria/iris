import { Browser, Page } from 'playwright';
import { Action } from '../src/translator';
import { launchBrowser, newPage, closeBrowser, click, typeText } from '../src/browser';

// Define types for the ActionExecutor module
export interface ExecutionResult {
  success: boolean;
  action: Action;
  error?: string;
  duration?: number;
  context?: {
    url?: string;
    title?: string;
    timestamp: number;
  };
}

export interface ActionExecutorOptions {
  retryAttempts?: number;
  retryDelay?: number;
  timeout?: number;
  trackContext?: boolean;
}

export interface PageContext {
  url?: string;
  title?: string;
  timestamp: number;
}

// Mock the browser module
jest.mock('../src/browser', () => ({
  launchBrowser: jest.fn(),
  newPage: jest.fn(),
  closeBrowser: jest.fn(),
  navigate: jest.fn(),
  click: jest.fn(),
  typeText: jest.fn(),
}));

describe('ActionExecutor', () => {
  let ActionExecutor: any;
  let mockBrowser: jest.Mocked<Browser>;
  let mockPage: jest.Mocked<Page>;
  let mockCdpSession: { send: jest.Mock; on: jest.Mock };
  let mockContext: { newCDPSession: jest.Mock; route: jest.Mock; on: jest.Mock };

  beforeAll(async () => {
    // Import the ActionExecutor class (which should be implemented)
    try {
      const module = await import('../src/executor');
      ActionExecutor = module.ActionExecutor;
    } catch {
      // If module doesn't exist yet, create a placeholder
      ActionExecutor = class ActionExecutor {
        constructor(_options?: ActionExecutorOptions) {}
        async launchBrowser(): Promise<Browser> {
          throw new Error('Not implemented');
        }
        async createPage(): Promise<Page> {
          throw new Error('Not implemented');
        }
        async executeAction(_action: Action, _page: Page): Promise<ExecutionResult> {
          throw new Error('Not implemented');
        }
        async executeActions(_actions: Action[], _page: Page): Promise<ExecutionResult[]> {
          throw new Error('Not implemented');
        }
        async cleanup(): Promise<void> {
          throw new Error('Not implemented');
        }
        async getPageContext(_page: Page): Promise<PageContext> {
          throw new Error('Not implemented');
        }
      };
    }
  });

  beforeEach(() => {
    // Setup mock browser and page
    mockBrowser = {
      close: jest.fn().mockResolvedValue(undefined),
      newPage: jest.fn(),
      contexts: jest.fn().mockReturnValue([]),
    } as any;

    // The URL-policy guard vets requests through a CDP Fetch session rather than
    // page.route (see src/url-policy-guard.ts), so a mock page has to be able to
    // hand one out or createPage cannot install the guard at all.
    mockCdpSession = { send: jest.fn().mockResolvedValue(undefined), on: jest.fn() };
    // The guard also attaches a context-level net for popups (issue #155), so
    // the fake context needs route/on as well as a CDP session.
    mockContext = {
      newCDPSession: jest.fn().mockResolvedValue(mockCdpSession),
      route: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
    };
    mockPage = {
      url: jest.fn().mockReturnValue('https://example.com'),
      title: jest.fn().mockResolvedValue('Test Page'),
      goto: jest.fn().mockResolvedValue(null),
      click: jest.fn().mockResolvedValue(undefined),
      fill: jest.fn().mockResolvedValue(undefined),
      setDefaultTimeout: jest.fn(),
      route: jest.fn().mockResolvedValue(undefined),
      routeWebSocket: jest.fn().mockResolvedValue(undefined),
      context: jest.fn().mockReturnValue(mockContext),
      close: jest.fn().mockResolvedValue(undefined),
      // The guard registers a close listener so a closed page's policy stops
      // being consulted for unattributable requests (issue #158).
      once: jest.fn(),
    } as any;

    // Setup browser module mocks
    (launchBrowser as jest.Mock).mockResolvedValue(mockBrowser);
    (newPage as jest.Mock).mockResolvedValue(mockPage);
    (closeBrowser as jest.Mock).mockResolvedValue(undefined);
    (click as jest.Mock).mockResolvedValue(undefined);
    (typeText as jest.Mock).mockResolvedValue(undefined);

    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create ActionExecutor with default options', () => {
      const executor = new ActionExecutor();
      expect(executor).toBeInstanceOf(ActionExecutor);
    });

    it('should create ActionExecutor with custom options', () => {
      const options: ActionExecutorOptions = {
        retryAttempts: 5,
        retryDelay: 2000,
        timeout: 10000,
        trackContext: true,
      };
      const executor = new ActionExecutor(options);
      expect(executor).toBeInstanceOf(ActionExecutor);
    });

    it('should handle partial options', () => {
      const options: ActionExecutorOptions = {
        retryAttempts: 3,
        trackContext: false,
      };
      const executor = new ActionExecutor(options);
      expect(executor).toBeInstanceOf(ActionExecutor);
    });
  });

  describe('browser lifecycle management', () => {
    let executor: any;

    beforeEach(() => {
      executor = new ActionExecutor();
    });

    it('should launch browser successfully', async () => {
      const browser = await executor.launchBrowser();

      expect(launchBrowser).toHaveBeenCalledTimes(1);
      expect(browser).toBe(mockBrowser);
    });

    it('should create new page successfully', async () => {
      const page = await executor.createPage();

      expect(launchBrowser).toHaveBeenCalledTimes(1);
      expect(newPage).toHaveBeenCalledWith(mockBrowser);
      expect(page).toBe(mockPage);
    });

    it('installs a request guard on every created page', async () => {
      // An earlier version of this test drove a synthetic route handler and
      // asserted that "a redirect hop to a metadata host arrives as a fresh
      // request and is aborted". That is not true of page.route — Chromium
      // follows a 30x without re-routing it — so the test pinned a fiction
      // (issue #148). Guard behaviour now lives in
      // __tests__/url-policy-guard.test.ts, against a real browser and a real
      // redirecting server. All that belongs here is that it gets installed.
      await executor.createPage();

      expect(mockCdpSession.send).toHaveBeenCalledWith(
        'Fetch.enable',
        expect.objectContaining({ patterns: [{ urlPattern: '*', requestStage: 'Request' }] }),
      );
      expect(mockCdpSession.on).toHaveBeenCalledWith('Fetch.requestPaused', expect.any(Function));
    });

    it('should cleanup browser resources', async () => {
      await executor.launchBrowser();
      await executor.cleanup();

      expect(closeBrowser).toHaveBeenCalledWith(mockBrowser);
    });

    it('should handle browser launch failure', async () => {
      const error = new Error('Browser launch failed');
      (launchBrowser as jest.Mock).mockRejectedValue(error);

      await expect(executor.launchBrowser()).rejects.toThrow('Browser launch failed');
    });

    it('should handle page creation failure', async () => {
      const error = new Error('Page creation failed');
      (newPage as jest.Mock).mockRejectedValue(error);

      await expect(executor.createPage()).rejects.toThrow('Page creation failed');
    });

    it('should handle cleanup gracefully when browser is null', async () => {
      // Don't launch browser first
      await expect(executor.cleanup()).resolves.not.toThrow();
    });
  });

  describe('executeAction', () => {
    let executor: any;
    let page: Page;

    beforeEach(async () => {
      executor = new ActionExecutor({ trackContext: true });
      page = await executor.createPage();
    });

    afterEach(async () => {
      await executor.cleanup();
    });

    describe('click actions', () => {
      it('should execute click action successfully', async () => {
        const action: Action = { type: 'click', selector: '#submit-btn' };

        const result = await executor.executeAction(action, page);

        expect(result.success).toBe(true);
        expect(result.action).toEqual(action);
        expect(result.error).toBeUndefined();
        expect(result.duration).toBeGreaterThanOrEqual(0);
        expect(result.context).toBeDefined();
        expect(result.context?.url).toBe('https://example.com');
        expect(result.context?.title).toBe('Test Page');
        expect(click).toHaveBeenCalledWith(page, '#submit-btn');
      });

      it('should handle click action failure', async () => {
        const action: Action = { type: 'click', selector: '#missing-btn' };
        const error = new Error('Element not found: #missing-btn');
        (click as jest.Mock).mockRejectedValue(error);

        const result = await executor.executeAction(action, page);

        expect(result.success).toBe(false);
        expect(result.action).toEqual(action);
        expect(result.error).toBe('Element not found: #missing-btn');
        expect(result.duration).toBeGreaterThanOrEqual(0);
      });

      it('should handle timeout error for click action', async () => {
        const action: Action = { type: 'click', selector: '#slow-btn' };
        const error = new Error('Timeout exceeded');
        (click as jest.Mock).mockRejectedValue(error);

        const result = await executor.executeAction(action, page);

        expect(result.success).toBe(false);
        expect(result.error).toBe('Timeout exceeded');
      });
    });

    describe('fill actions', () => {
      it('should execute fill action successfully', async () => {
        const action: Action = { type: 'fill', selector: '#email', text: 'test@example.com' };

        const result = await executor.executeAction(action, page);

        expect(result.success).toBe(true);
        expect(result.action).toEqual(action);
        expect(result.error).toBeUndefined();
        expect(result.duration).toBeGreaterThanOrEqual(0);
        expect(typeText).toHaveBeenCalledWith(page, '#email', 'test@example.com');
      });

      it('should handle fill action failure', async () => {
        const action: Action = { type: 'fill', selector: '#missing-input', text: 'test' };
        const error = new Error('Element not found: #missing-input');
        (typeText as jest.Mock).mockRejectedValue(error);

        const result = await executor.executeAction(action, page);

        expect(result.success).toBe(false);
        expect(result.action).toEqual(action);
        expect(result.error).toBe('Element not found: #missing-input');
      });

      it('should handle empty text for fill action', async () => {
        const action: Action = { type: 'fill', selector: '#input', text: '' };

        const result = await executor.executeAction(action, page);

        expect(result.success).toBe(true);
        expect(typeText).toHaveBeenCalledWith(page, '#input', '');
      });

      it('should handle special characters in fill text', async () => {
        const action: Action = { type: 'fill', selector: '#input', text: 'ñáéíóú@#$%^&*()' };

        const result = await executor.executeAction(action, page);

        expect(result.success).toBe(true);
        expect(typeText).toHaveBeenCalledWith(page, '#input', 'ñáéíóú@#$%^&*()');
      });
    });

    describe('navigate actions', () => {
      it('should execute navigate action successfully', async () => {
        const action: Action = { type: 'navigate', url: 'https://google.com' };
        mockPage.url.mockReturnValue('https://google.com');
        mockPage.title.mockResolvedValue('Google');

        const result = await executor.executeAction(action, page);

        expect(result.success).toBe(true);
        expect(result.action).toEqual(action);
        expect(result.error).toBeUndefined();
        expect(result.context?.url).toBe('https://google.com');
        expect(result.context?.title).toBe('Google');
        expect(mockPage.goto).toHaveBeenCalledWith('https://google.com', undefined);
      });

      it('should handle navigate action failure', async () => {
        const action: Action = { type: 'navigate', url: 'https://invalid-url' };
        const error = new Error('Navigation failed');
        mockPage.goto.mockRejectedValue(error);

        const result = await executor.executeAction(action, page);

        expect(result.success).toBe(false);
        expect(result.action).toEqual(action);
        expect(result.error).toBe('Navigation failed');
      });

      it('should handle network timeout for navigate action', async () => {
        const action: Action = { type: 'navigate', url: 'https://slow-site.com' };
        const error = new Error('net::ERR_NETWORK_TIMEOUT');
        mockPage.goto.mockRejectedValue(error);

        const result = await executor.executeAction(action, page);

        expect(result.success).toBe(false);
        expect(result.error).toBe('net::ERR_NETWORK_TIMEOUT');
      });

      describe('URL policy enforcement (SSRF / local-file gate)', () => {
        it('rejects file:// navigation without calling page.goto', async () => {
          const action: Action = { type: 'navigate', url: 'file:///etc/passwd' };

          const result = await executor.executeAction(action, page);

          expect(result.success).toBe(false);
          expect(result.error).toMatch(/blocked/i);
          expect(mockPage.goto).not.toHaveBeenCalled();
        });

        it('rejects the cloud-metadata IP without retrying', async () => {
          const action: Action = {
            type: 'navigate',
            url: 'http://169.254.169.254/latest/meta-data/',
          };

          const result = await executor.executeAction(action, page);

          expect(result.success).toBe(false);
          expect(result.error).toMatch(/blocked/i);
          expect(mockPage.goto).not.toHaveBeenCalled();
        });

        it('allows file:// when the executor opts in', async () => {
          const fileExecutor = new ActionExecutor({ urlPolicy: { allowFile: true } });
          // Its OWN page: the guard is installed per page with the policy of the
          // executor that created it, so driving a default executor's page
          // through this one would be testing a mismatch that cannot occur.
          const filePage = await fileExecutor.createPage();
          const action: Action = { type: 'navigate', url: 'file:///tmp/page.html' };

          const result = await fileExecutor.executeAction(action, filePage);

          expect(result.success).toBe(true);
          expect(mockPage.goto).toHaveBeenCalledWith('file:///tmp/page.html', undefined);
        });
      });
    });

    it('should not track context when trackContext is false', async () => {
      const executorNoContext = new ActionExecutor({ trackContext: false });
      const pageNoContext = await executorNoContext.createPage();
      const action: Action = { type: 'click', selector: '#btn' };

      const result = await executorNoContext.executeAction(action, pageNoContext);

      expect(result.success).toBe(true);
      expect(result.context).toBeUndefined();

      await executorNoContext.cleanup();
    });

    it('should measure execution duration accurately', async () => {
      const action: Action = { type: 'click', selector: '#btn' };

      // Add delay to mock
      (click as jest.Mock).mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 100)),
      );

      const result = await executor.executeAction(action, page);

      // setTimeout(100) + Date.now() deltas can under-measure by a millisecond
      // or two (timer coalescing / sub-ms rounding), so allow a small tolerance
      // below the nominal delay — the point is that duration reflects the ~100ms
      // wait, not that it lands on exactly 100. See CI flake: measured 99.
      expect(result.duration).toBeGreaterThanOrEqual(90);
      // The companion `toBeLessThan(200)` was dropped for #142. A loaded machine
      // pushes a 100ms wait past 200ms with nothing wrong, and the bound guarded
      // nothing the lower bound does not — "duration tracks the delay" is the
      // property; "and finishes quickly" is a statement about the host.
    });
  });

  describe('executeActions (sequence)', () => {
    let executor: any;
    let page: Page;

    beforeEach(async () => {
      executor = new ActionExecutor({ trackContext: true });
      page = await executor.createPage();
    });

    afterEach(async () => {
      await executor.cleanup();
    });

    it('should execute multiple actions successfully', async () => {
      const actions: Action[] = [
        { type: 'navigate', url: 'https://login.example.com' },
        { type: 'fill', selector: '#email', text: 'user@example.com' },
        { type: 'fill', selector: '#password', text: 'password123' },
        { type: 'click', selector: '#login-btn' },
      ];

      mockPage.url.mockReturnValue('https://login.example.com');
      mockPage.title.mockResolvedValue('Login Page');

      const results = await executor.executeActions(actions, page);

      expect(results).toHaveLength(4);
      expect(results.every((r: ExecutionResult) => r.success)).toBe(true);
      expect(mockPage.goto).toHaveBeenCalledWith('https://login.example.com', undefined);
      expect(typeText).toHaveBeenCalledWith(page, '#email', 'user@example.com');
      expect(typeText).toHaveBeenCalledWith(page, '#password', 'password123');
      expect(click).toHaveBeenCalledWith(page, '#login-btn');
    });

    it('should handle partial failure in action sequence', async () => {
      const actions: Action[] = [
        { type: 'navigate', url: 'https://example.com' },
        { type: 'fill', selector: '#valid-input', text: 'test' },
        { type: 'fill', selector: '#missing-input', text: 'fail' },
        { type: 'click', selector: '#submit' },
      ];

      // Mock the third action to fail
      (typeText as jest.Mock)
        .mockResolvedValueOnce(undefined) // First fill succeeds
        .mockRejectedValueOnce(new Error('Element not found')); // Second fill fails

      const results = await executor.executeActions(actions, page);

      expect(results).toHaveLength(4);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
      expect(results[2].success).toBe(false);
      expect(results[2].error).toBe('Element not found');
      expect(results[3].success).toBe(true); // Should continue after failure
    });

    it('should handle empty action array', async () => {
      const actions: Action[] = [];

      const results = await executor.executeActions(actions, page);

      expect(results).toHaveLength(0);
      expect(mockPage.goto).not.toHaveBeenCalled();
      expect(click).not.toHaveBeenCalled();
      expect(typeText).not.toHaveBeenCalled();
    });

    it('should maintain action order in results', async () => {
      const actions: Action[] = [
        { type: 'click', selector: '#first' },
        { type: 'fill', selector: '#second', text: 'test' },
        { type: 'navigate', url: 'https://example.com' },
      ];

      const results = await executor.executeActions(actions, page);

      expect(results).toHaveLength(3);
      expect(results[0].action.type).toBe('click');
      expect(results[1].action.type).toBe('fill');
      expect(results[2].action.type).toBe('navigate');
    });

    it('should update context for each action that changes page state', async () => {
      const actions: Action[] = [
        { type: 'navigate', url: 'https://page1.com' },
        { type: 'click', selector: '#link-to-page2' },
      ];

      // Simulate page changes
      mockPage.url
        .mockReturnValueOnce('https://page1.com')
        .mockReturnValueOnce('https://page2.com');
      mockPage.title.mockResolvedValueOnce('Page 1').mockResolvedValueOnce('Page 2');

      const results = await executor.executeActions(actions, page);

      expect(results[0].context?.url).toBe('https://page1.com');
      expect(results[0].context?.title).toBe('Page 1');
      expect(results[1].context?.url).toBe('https://page2.com');
      expect(results[1].context?.title).toBe('Page 2');
    });
  });

  describe('retry logic', () => {
    let executor: any;
    let page: Page;

    beforeEach(async () => {
      executor = new ActionExecutor({
        retryAttempts: 3,
        retryDelay: 100,
        trackContext: false,
      });
      page = await executor.createPage();
    });

    afterEach(async () => {
      await executor.cleanup();
    });

    it('should retry failed actions and eventually succeed', async () => {
      const action: Action = { type: 'click', selector: '#retry-btn' };

      // Mock to fail twice, then succeed
      (click as jest.Mock)
        .mockRejectedValueOnce(new Error('Temporary failure 1'))
        .mockRejectedValueOnce(new Error('Temporary failure 2'))
        .mockResolvedValueOnce(undefined);

      const result = await executor.executeAction(action, page);

      expect(result.success).toBe(true);
      expect(click).toHaveBeenCalledTimes(3);
    });

    it('should fail after exhausting all retry attempts', async () => {
      const action: Action = { type: 'click', selector: '#always-fails' };
      const persistentError = new Error('Persistent failure');

      (click as jest.Mock).mockRejectedValue(persistentError);

      const result = await executor.executeAction(action, page);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Persistent failure');
      expect(click).toHaveBeenCalledTimes(4); // Initial + 3 retries
    });

    it('should respect retry delay between attempts', async () => {
      const action: Action = { type: 'click', selector: '#slow-retry' };

      (click as jest.Mock).mockRejectedValue(new Error('Always fails'));

      // Issue #142: this measured `endTime - startTime >= 300`. Load cannot
      // break a lower bound — it only makes elapsed time larger — yet the test
      // was observed failing, which is what pointed at the other mechanism this
      // issue documents: the WSL2 system clock stepping backward mid-test.
      //
      // Asserting on the delay seam instead is immune to the clock and strictly
      // stronger: elapsed >= 300 could not tell three 100ms waits apart from one
      // 300ms stall, which is the thing that would actually be a bug.
      const delaySpy = jest.spyOn(
        executor as unknown as { delay(ms: number): Promise<void> },
        'delay',
      );

      await executor.executeAction(action, page);

      // Every gap, not just one: `toHaveBeenCalledWith(100)` would accept a
      // regression that waited [100, 0, 0], which is exactly the bug this test
      // exists to catch.
      expect(delaySpy.mock.calls).toEqual([[100], [100], [100]]);
      delaySpy.mockRestore();
    });

    it('should not retry on certain error types', async () => {
      const executorNoRetry = new ActionExecutor({
        retryAttempts: 3,
        retryDelay: 100,
      });
      const pageNoRetry = await executorNoRetry.createPage();
      // Policy-valid URL so this exercises the non-retryable *navigation error*
      // path (below), not the URL-policy gate which rejects before goto.
      const action: Action = { type: 'navigate', url: 'https://example.com' };

      // Simulate a non-retryable error (e.g., invalid URL)
      const invalidUrlError = new Error('Invalid URL');
      mockPage.goto.mockRejectedValue(invalidUrlError);

      const result = await executorNoRetry.executeAction(action, pageNoRetry);

      expect(result.success).toBe(false);
      // For invalid URLs, should not retry
      expect(mockPage.goto).toHaveBeenCalledTimes(1);

      await executorNoRetry.cleanup();
    });

    it.each([
      [
        'a blocked redirect target',
        'https://x/ redirects to http://169.254.169.254/, which is blocked by navigation policy',
      ],
      ['a blocked URL', 'https://x/ blocked by navigation policy: https://x/'],
      ['a redirect loop', 'https://x/ exceeded 10 redirects without settling'],
      ['an unparseable Location', 'https://x/ redirects to an unparseable location: %%%'],
    ])('does not retry a navigation the guard refused — %s', async (_label, message) => {
      // These are deterministic policy verdicts: the URL is just as blocked on
      // the fourth attempt, and each retry re-walks the whole redirect chain.
      const retrying = new ActionExecutor({ retryAttempts: 3, retryDelay: 1 });
      const retryPage = await retrying.createPage();
      mockPage.goto.mockRejectedValue(new Error(message));

      const result = await retrying.executeAction(
        { type: 'navigate', url: 'https://example.com' } as Action,
        retryPage,
      );

      expect(result.success).toBe(false);
      expect(mockPage.goto).toHaveBeenCalledTimes(1);

      await retrying.cleanup();
    });

    // Issue #75: the non-retryable list said 'element not found', but Playwright
    // never emits that. A missing selector produces a timeout message, so the
    // most common failure mode was retried — each attempt burning the full page
    // timeout (~30s), turning a 30s failure into ~92s and risking CI timeouts.
    describe('Playwright timeout errors are deterministic, not transient', () => {
      const missingSelector = () =>
        // Verbatim shape of a real Playwright failure, including the locator tail.
        new Error(
          'page.click: Timeout 30000ms exceeded.\n' +
            "Call log:\n  - waiting for locator('#missing')\n",
        );

      it('does not retry a missing selector on click', async () => {
        const exec = new ActionExecutor({ retryAttempts: 3, retryDelay: 1 });
        const page = await exec.createPage();
        (click as jest.Mock).mockRejectedValue(missingSelector());

        const result = await exec.executeAction(
          { type: 'click', selector: '#missing' } as Action,
          page,
        );

        expect(result.success).toBe(false);
        expect(click).toHaveBeenCalledTimes(1);
        await exec.cleanup();
      });

      it('does not retry a missing selector on fill', async () => {
        const exec = new ActionExecutor({ retryAttempts: 3, retryDelay: 1 });
        const page = await exec.createPage();
        (typeText as jest.Mock).mockRejectedValue(
          new Error("page.fill: Timeout 15000ms exceeded.\n  - waiting for locator('#nope')"),
        );

        const result = await exec.executeAction(
          { type: 'fill', selector: '#nope', text: 'x' } as Action,
          page,
        );

        expect(result.success).toBe(false);
        expect(typeText).toHaveBeenCalledTimes(1);
        await exec.cleanup();
      });

      it('does not retry an ambiguous selector (strict mode violation)', async () => {
        const exec = new ActionExecutor({ retryAttempts: 3, retryDelay: 1 });
        const page = await exec.createPage();
        (click as jest.Mock).mockRejectedValue(
          new Error(
            "locator.click: Error: strict mode violation: locator('button') resolved to 3 elements",
          ),
        );

        const result = await exec.executeAction(
          { type: 'click', selector: 'button' } as Action,
          page,
        );

        expect(result.success).toBe(false);
        expect(click).toHaveBeenCalledTimes(1);
        await exec.cleanup();
      });

      // The guard must stay narrow: genuinely transient faults still get retries,
      // because those fail fast rather than consuming the whole timeout budget.
      it('still retries a transient network error', async () => {
        const exec = new ActionExecutor({ retryAttempts: 2, retryDelay: 1 });
        const page = await exec.createPage();
        (click as jest.Mock).mockRejectedValue(new Error('net::ERR_CONNECTION_RESET'));

        const result = await exec.executeAction(
          { type: 'click', selector: '#btn' } as Action,
          page,
        );

        expect(result.success).toBe(false);
        expect(click).toHaveBeenCalledTimes(3); // initial + 2 retries
        await exec.cleanup();
      });
    });
  });

  describe('page context tracking', () => {
    let executor: any;
    let page: Page;

    beforeEach(async () => {
      executor = new ActionExecutor({ trackContext: true });
      page = await executor.createPage();
    });

    afterEach(async () => {
      await executor.cleanup();
    });

    it('should get current page context', async () => {
      mockPage.url.mockReturnValue('https://example.com/page');
      mockPage.title.mockResolvedValue('Example Page');

      // Pin the clock instead of comparing against a moving one (#142). A
      // before/after bracket was the first attempt, but review pointed out it
      // still assumes wall-clock monotonicity — a backward step between `before`
      // and the internal stamp fails it while the code is correct. Freezing
      // Date.now() removes the assumption entirely and asserts the exact
      // property: the stamp is taken from the clock during this call.
      const NOW = 1_700_000_000_000;
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW);
      try {
        const context = await executor.getPageContext(page);

        expect(context.url).toBe('https://example.com/page');
        expect(context.title).toBe('Example Page');
        expect(context.timestamp).toBe(NOW);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('should handle page context retrieval failure', async () => {
      mockPage.title.mockRejectedValue(new Error('Page not loaded'));

      const context = await executor.getPageContext(page);

      expect(context.url).toBe('https://example.com'); // From url() mock
      expect(context.title).toBeUndefined();
      expect(context.timestamp).toBeDefined();
    });

    it('should track context changes during navigation', async () => {
      const action: Action = { type: 'navigate', url: 'https://newsite.com' };

      // Simulate page change
      mockPage.url.mockReturnValue('https://newsite.com');
      mockPage.title.mockResolvedValue('New Site');

      const result = await executor.executeAction(action, page);

      expect(result.context?.url).toBe('https://newsite.com');
      expect(result.context?.title).toBe('New Site');
    });
  });

  describe('error handling edge cases', () => {
    let executor: any;

    beforeEach(() => {
      executor = new ActionExecutor();
    });

    it('should handle page being null or undefined', async () => {
      const action: Action = { type: 'click', selector: '#btn' };

      await expect(executor.executeAction(action, null)).rejects.toThrow();
    });

    it('should handle browser being closed during execution', async () => {
      const page = await executor.createPage();
      const action: Action = { type: 'click', selector: '#btn' };

      // Simulate browser being closed
      (click as jest.Mock).mockRejectedValue(new Error('Browser has been closed'));

      const result = await executor.executeAction(action, page);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Browser has been closed');

      await executor.cleanup();
    });

    it('should handle concurrent action execution', async () => {
      const page = await executor.createPage();
      const actions: Action[] = [
        { type: 'click', selector: '#btn1' },
        { type: 'click', selector: '#btn2' },
        { type: 'click', selector: '#btn3' },
      ];

      // Execute actions concurrently (though not recommended)
      const promises = actions.map((action) => executor.executeAction(action, page));

      const results = await Promise.all(promises);

      expect(results).toHaveLength(3);
      expect(results.every((r: ExecutionResult) => r.success)).toBe(true);

      await executor.cleanup();
    });

    it('should provide meaningful error messages for common failures', async () => {
      const page = await executor.createPage();
      const testCases = [
        {
          action: { type: 'click', selector: '#missing' } as Action,
          mockError: new Error('Element not found: selector: "#missing"'),
          expectedError: 'Element not found: selector: "#missing"',
        },
        {
          action: { type: 'fill', selector: '#readonly', text: 'test' } as Action,
          mockError: new Error('Element is read-only'),
          expectedError: 'Element is read-only',
        },
        {
          action: { type: 'navigate', url: 'https://blocked.com' } as Action,
          mockError: new Error('net::ERR_BLOCKED_BY_CLIENT'),
          expectedError: 'net::ERR_BLOCKED_BY_CLIENT',
        },
      ];

      for (const testCase of testCases) {
        // Setup mock for this test case
        if (testCase.action.type === 'click') {
          (click as jest.Mock).mockRejectedValueOnce(testCase.mockError);
        } else if (testCase.action.type === 'fill') {
          (typeText as jest.Mock).mockRejectedValueOnce(testCase.mockError);
        } else if (testCase.action.type === 'navigate') {
          mockPage.goto.mockRejectedValueOnce(testCase.mockError);
        }

        const result = await executor.executeAction(testCase.action, page);

        expect(result.success).toBe(false);
        expect(result.error).toBe(testCase.expectedError);
      }

      await executor.cleanup();
    });
  });

  describe('performance and resource management', () => {
    it('should handle multiple executor instances', async () => {
      const executor1 = new ActionExecutor();
      const executor2 = new ActionExecutor();

      const page1 = await executor1.createPage();
      const page2 = await executor2.createPage();

      const action: Action = { type: 'click', selector: '#btn' };

      const [result1, result2] = await Promise.all([
        executor1.executeAction(action, page1),
        executor2.executeAction(action, page2),
      ]);

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);

      await Promise.all([executor1.cleanup(), executor2.cleanup()]);
    });

    it('should properly cleanup resources on multiple cleanup calls', async () => {
      const executor = new ActionExecutor();
      await executor.launchBrowser();

      // Multiple cleanup calls should not cause errors
      await executor.cleanup();
      await executor.cleanup();
      await executor.cleanup();

      // Should only call closeBrowser once
      expect(closeBrowser).toHaveBeenCalledTimes(1);
    });

    it('should handle timeout configuration', async () => {
      const executor = new ActionExecutor({ timeout: 5000 });
      await executor.createPage();

      // Verify timeout is set on page
      expect(mockPage.setDefaultTimeout).toHaveBeenCalledWith(5000);

      await executor.cleanup();
    });
  });
});
