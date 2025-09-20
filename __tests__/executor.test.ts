import { Browser, Page } from 'playwright';
import { Action } from '../src/translator';
import { launchBrowser, newPage, closeBrowser, navigate, click, typeText } from '../src/browser';

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

  beforeAll(async () => {
    // Import the ActionExecutor class (which should be implemented)
    try {
      const module = await import('../src/executor');
      ActionExecutor = module.ActionExecutor;
    } catch (error) {
      // If module doesn't exist yet, create a placeholder
      ActionExecutor = class ActionExecutor {
        constructor(options?: ActionExecutorOptions) {}
        async launchBrowser(): Promise<Browser> { throw new Error('Not implemented'); }
        async createPage(): Promise<Page> { throw new Error('Not implemented'); }
        async executeAction(action: Action, page: Page): Promise<ExecutionResult> { throw new Error('Not implemented'); }
        async executeActions(actions: Action[], page: Page): Promise<ExecutionResult[]> { throw new Error('Not implemented'); }
        async cleanup(): Promise<void> { throw new Error('Not implemented'); }
        async getPageContext(page: Page): Promise<PageContext> { throw new Error('Not implemented'); }
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

    mockPage = {
      url: jest.fn().mockReturnValue('https://example.com'),
      title: jest.fn().mockResolvedValue('Test Page'),
      goto: jest.fn().mockResolvedValue(null),
      click: jest.fn().mockResolvedValue(undefined),
      fill: jest.fn().mockResolvedValue(undefined),
      setDefaultTimeout: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    } as any;

    // Setup browser module mocks
    (launchBrowser as jest.Mock).mockResolvedValue(mockBrowser);
    (newPage as jest.Mock).mockResolvedValue(mockPage);
    (closeBrowser as jest.Mock).mockResolvedValue(undefined);
    (navigate as jest.Mock).mockResolvedValue(undefined);
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
        expect(navigate).toHaveBeenCalledWith(page, 'https://google.com');
      });

      it('should handle navigate action failure', async () => {
        const action: Action = { type: 'navigate', url: 'https://invalid-url' };
        const error = new Error('Navigation failed');
        (navigate as jest.Mock).mockRejectedValue(error);

        const result = await executor.executeAction(action, page);

        expect(result.success).toBe(false);
        expect(result.action).toEqual(action);
        expect(result.error).toBe('Navigation failed');
      });

      it('should handle network timeout for navigate action', async () => {
        const action: Action = { type: 'navigate', url: 'https://slow-site.com' };
        const error = new Error('net::ERR_NETWORK_TIMEOUT');
        (navigate as jest.Mock).mockRejectedValue(error);

        const result = await executor.executeAction(action, page);

        expect(result.success).toBe(false);
        expect(result.error).toBe('net::ERR_NETWORK_TIMEOUT');
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
      (click as jest.Mock).mockImplementation(() =>
        new Promise(resolve => setTimeout(resolve, 100))
      );

      const result = await executor.executeAction(action, page);

      expect(result.duration).toBeGreaterThanOrEqual(100);
      expect(result.duration).toBeLessThan(200); // Should complete quickly
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
      expect(navigate).toHaveBeenCalledWith(page, 'https://login.example.com');
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
      expect(navigate).not.toHaveBeenCalled();
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
      mockPage.title
        .mockResolvedValueOnce('Page 1')
        .mockResolvedValueOnce('Page 2');

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
        trackContext: false
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

      const startTime = Date.now();
      await executor.executeAction(action, page);
      const endTime = Date.now();

      // Should have waited at least 3 * 100ms = 300ms for retries
      expect(endTime - startTime).toBeGreaterThanOrEqual(300);
    });

    it('should not retry on certain error types', async () => {
      const executorNoRetry = new ActionExecutor({
        retryAttempts: 3,
        retryDelay: 100
      });
      const pageNoRetry = await executorNoRetry.createPage();
      const action: Action = { type: 'navigate', url: 'invalid://url' };

      // Simulate a non-retryable error (e.g., invalid URL)
      const invalidUrlError = new Error('Invalid URL');
      (navigate as jest.Mock).mockRejectedValue(invalidUrlError);

      const result = await executorNoRetry.executeAction(action, pageNoRetry);

      expect(result.success).toBe(false);
      // For invalid URLs, should not retry
      expect(navigate).toHaveBeenCalledTimes(1);

      await executorNoRetry.cleanup();
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

      const context = await executor.getPageContext(page);

      expect(context.url).toBe('https://example.com/page');
      expect(context.title).toBe('Example Page');
      expect(context.timestamp).toBeCloseTo(Date.now(), -2); // Within 100ms
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

      await expect(
        executor.executeAction(action, null)
      ).rejects.toThrow();
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
      const promises = actions.map(action =>
        executor.executeAction(action, page)
      );

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
          expectedError: 'Element not found: selector: "#missing"'
        },
        {
          action: { type: 'fill', selector: '#readonly', text: 'test' } as Action,
          mockError: new Error('Element is read-only'),
          expectedError: 'Element is read-only'
        },
        {
          action: { type: 'navigate', url: 'https://blocked.com' } as Action,
          mockError: new Error('net::ERR_BLOCKED_BY_CLIENT'),
          expectedError: 'net::ERR_BLOCKED_BY_CLIENT'
        }
      ];

      for (const testCase of testCases) {
        // Setup mock for this test case
        if (testCase.action.type === 'click') {
          (click as jest.Mock).mockRejectedValueOnce(testCase.mockError);
        } else if (testCase.action.type === 'fill') {
          (typeText as jest.Mock).mockRejectedValueOnce(testCase.mockError);
        } else if (testCase.action.type === 'navigate') {
          (navigate as jest.Mock).mockRejectedValueOnce(testCase.mockError);
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

      await Promise.all([
        executor1.cleanup(),
        executor2.cleanup(),
      ]);
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
      const page = await executor.createPage();

      // Verify timeout is set on page
      expect(mockPage.setDefaultTimeout).toHaveBeenCalledWith(5000);

      await executor.cleanup();
    });
  });
});