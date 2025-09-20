import { Browser, Page } from 'playwright';
import { Action } from './translator';
import { launchBrowser, newPage, closeBrowser, navigate, click, typeText, BrowserLaunchOptions } from './browser';

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
  browserOptions?: BrowserLaunchOptions;
}

export interface PageContext {
  url?: string;
  title?: string;
  timestamp: number;
}

/**
 * ActionExecutor handles the execution of translated actions with retry logic,
 * error handling, and browser lifecycle management.
 */
export class ActionExecutor {
  private readonly options: Required<Omit<ActionExecutorOptions, 'browserOptions'>> & { browserOptions: BrowserLaunchOptions };
  private browser: Browser | null = null;

  constructor(options: ActionExecutorOptions = {}) {
    this.options = {
      retryAttempts: options.retryAttempts ?? 3,
      retryDelay: options.retryDelay ?? 1000,
      timeout: options.timeout ?? 30000,
      trackContext: options.trackContext ?? true,
      browserOptions: options.browserOptions ?? { headless: true },
    };
  }

  /**
   * Launch a new browser instance.
   */
  async launchBrowser(): Promise<Browser> {
    try {
      this.browser = await launchBrowser(this.options.browserOptions);
      return this.browser;
    } catch (error) {
      throw new Error(`Browser launch failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Create a new page, launching browser if needed.
   */
  async createPage(): Promise<Page> {
    try {
      if (!this.browser) {
        await this.launchBrowser();
      }

      const page = await newPage(this.browser!);

      // Set timeout if configured
      if (this.options.timeout) {
        page.setDefaultTimeout(this.options.timeout);
      }

      return page;
    } catch (error) {
      throw new Error(`Page creation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Execute a single action with retry logic and error handling.
   */
  async executeAction(action: Action, page: Page): Promise<ExecutionResult> {
    if (!page) {
      throw new Error('Page is null or undefined');
    }

    const startTime = Date.now();
    let lastError: Error | null = null;

    // Try initial execution + retries
    for (let attempt = 0; attempt <= this.options.retryAttempts; attempt++) {
      try {
        await this.performAction(action, page);

        const duration = Date.now() - startTime;
        const context = this.options.trackContext ? await this.getPageContext(page) : undefined;

        return {
          success: true,
          action,
          duration,
          context,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Check if this is a non-retryable error
        if (this.isNonRetryableError(lastError)) {
          break;
        }

        // If this isn't the last attempt, wait before retrying
        if (attempt < this.options.retryAttempts) {
          await this.delay(this.options.retryDelay);
        }
      }
    }

    // All attempts failed
    const duration = Date.now() - startTime;
    const context = this.options.trackContext ? await this.getPageContext(page) : undefined;

    return {
      success: false,
      action,
      error: lastError?.message || 'Unknown error',
      duration,
      context,
    };
  }

  /**
   * Execute a sequence of actions.
   */
  async executeActions(actions: Action[], page: Page): Promise<ExecutionResult[]> {
    const results: ExecutionResult[] = [];

    for (const action of actions) {
      const result = await this.executeAction(action, page);
      results.push(result);
    }

    return results;
  }

  /**
   * Get current page context (URL, title, timestamp).
   */
  async getPageContext(page: Page): Promise<PageContext> {
    const timestamp = Date.now();

    try {
      const url = page.url();
      let title: string | undefined;

      try {
        title = await page.title();
      } catch (error) {
        // Title retrieval failed, but we can still return URL
        title = undefined;
      }

      return {
        url,
        title,
        timestamp,
      };
    } catch (error) {
      // Even URL retrieval failed
      return {
        timestamp,
      };
    }
  }

  /**
   * Clean up browser resources.
   */
  async cleanup(): Promise<void> {
    if (this.browser) {
      try {
        await closeBrowser(this.browser);
      } catch (error) {
        // Ignore cleanup errors
      } finally {
        this.browser = null;
      }
    }
  }

  /**
   * Perform the actual action on the page.
   */
  private async performAction(action: Action, page: Page): Promise<void> {
    switch (action.type) {
      case 'click':
        await click(page, action.selector);
        break;

      case 'fill':
        await typeText(page, action.selector, action.text);
        break;

      case 'navigate':
        await navigate(page, action.url);
        break;

      default:
        throw new Error(`Unsupported action type: ${(action as any).type}`);
    }
  }

  /**
   * Check if an error should not be retried.
   */
  private isNonRetryableError(error: Error): boolean {
    const message = error.message.toLowerCase();

    // Don't retry on certain types of errors
    const nonRetryablePatterns = [
      'invalid url',
      'browser has been closed',
      'page has been closed',
      'element is read-only',
      'element not found',
      'net::err_blocked_by_client',
      'net::err_network_timeout',
    ];

    return nonRetryablePatterns.some(pattern => message.includes(pattern));
  }

  /**
   * Wait for the specified delay.
   */
  private async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}