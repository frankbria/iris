import { Browser, Page } from 'playwright';
import { Action } from './translator';
import {
  launchBrowser,
  newPage,
  closeBrowser,
  navigate,
  click,
  typeText,
  BrowserLaunchOptions,
} from './browser';
import { assertNavigationAllowed, isNavigationAllowed, UrlPolicyOptions } from './url-policy';

/**
 * A page state that did not hold. Distinct from an infrastructure error so the
 * retry logic can recognise it as deterministic: re-checking an unchanged page
 * yields the same answer, so retrying only burns the timeout again.
 */
export class AssertionFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionFailedError';
  }
}

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
  /** Navigation URL policy applied at the performAction boundary (defaults: http(s)-only, file:// off, metadata/link-local blocked). */
  urlPolicy?: UrlPolicyOptions;
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
  private readonly options: Required<
    Omit<ActionExecutorOptions, 'browserOptions' | 'urlPolicy'>
  > & {
    browserOptions: BrowserLaunchOptions;
    urlPolicy: UrlPolicyOptions;
  };
  private browser: Browser | null = null;

  constructor(options: ActionExecutorOptions = {}) {
    this.options = {
      retryAttempts: options.retryAttempts ?? 3,
      retryDelay: options.retryDelay ?? 1000,
      timeout: options.timeout ?? 30000,
      trackContext: options.trackContext ?? true,
      browserOptions: options.browserOptions ?? { headless: true },
      urlPolicy: options.urlPolicy ?? {},
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
      throw new Error(
        `Browser launch failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
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

      // Enforce the URL policy on EVERY request the page makes, not just the
      // initial navigate action URL — this closes the redirect-based SSRF bypass
      // where a public URL 30x-redirects to a metadata/link-local host.
      await page.route('**/*', (route) => {
        if (isNavigationAllowed(route.request().url(), this.options.urlPolicy)) {
          route.continue();
        } else {
          route.abort('blockedbyclient');
        }
      });

      // Set timeout if configured
      if (this.options.timeout) {
        page.setDefaultTimeout(this.options.timeout);
      }

      return page;
    } catch (error) {
      throw new Error(
        `Page creation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
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
        // Bound title retrieval: after a blocked/aborted navigation the frame can
        // leave page.title() pending indefinitely, so race it against a short timer.
        title = await Promise.race([page.title(), this.delay(2000).then(() => undefined)]);
      } catch {
        // Title retrieval failed, but we can still return URL
        title = undefined;
      }

      return {
        url,
        title,
        timestamp,
      };
    } catch {
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
      } catch {
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
        // Single security boundary: reject non-web schemes and SSRF/local-file
        // targets before any page.goto. All RPC/AI/pattern navs funnel through here.
        assertNavigationAllowed(action.url, this.options.urlPolicy);
        await navigate(page, action.url);
        break;

      case 'assert':
        await this.performAssert(action, page);
        break;

      default:
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        throw new Error(`Unsupported action type: ${(action as any).type}`);
    }
  }

  /**
   * Evaluate an assertion against the live page.
   *
   * A failing assertion throws AssertionFailedError, which `executeAction` turns
   * into `success: false`. It must reach the caller as a *result*, not a raw
   * exception — a thrown assertion would be retried (pointlessly, since the page
   * is unchanged) and miscounted in the summary.
   */
  private async performAssert(
    action: Extract<Action, { type: 'assert' }>,
    page: Page,
  ): Promise<void> {
    const timeout = this.options.timeout ?? 30000;
    let holds: boolean;

    switch (action.kind) {
      case 'text_visible':
        holds = await this.isVisible(page.getByText(action.target).first(), timeout);
        break;

      case 'element_visible':
        holds = await this.isVisible(page.locator(action.target).first(), timeout);
        break;

      case 'element_absent':
        // Not simply !element_visible: absence should not wait out the full
        // timeout hoping something appears, so give it a short grace period.
        holds = !(await this.isVisible(
          page.locator(action.target).first(),
          Math.min(timeout, 1000),
        ));
        break;

      case 'url_matches':
        // Auto-waits like the other kinds. A single synchronous read races an
        // async URL change — an SPA route transition or redirect kicked off by a
        // preceding click lands after this line, producing a false negative.
        holds = await this.urlBecomes(page, action.target, timeout);
        break;

      default: {
        const exhaustive: never = action.kind;
        throw new Error(`Unsupported assertion kind: ${String(exhaustive)}`);
      }
    }

    if (!holds) {
      throw new AssertionFailedError(`Assertion failed: ${action.kind} ${action.target}`.trim());
    }
  }

  /**
   * Whether the page URL comes to contain `substring` within `timeout`.
   *
   * Uses Playwright's own URL wait so a redirect or SPA route change that is
   * still in flight is given the same grace the visibility checks get. A timeout
   * means "it never matched", which is an answer, not an error.
   */
  private async urlBecomes(page: Page, substring: string, timeout: number): Promise<boolean> {
    if (page.url().includes(substring)) {
      return true; // already there — skip the wait entirely
    }

    try {
      await page.waitForURL((url) => url.href.includes(substring), { timeout });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Whether a locator becomes visible within `timeout`. A timeout means "not
   * visible", which is an answer, not an error.
   */
  private async isVisible(locator: ReturnType<Page['locator']>, timeout: number): Promise<boolean> {
    try {
      await locator.waitFor({ state: 'visible', timeout });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if an error should not be retried.
   *
   * The distinction that matters is cost, not just determinism: a Playwright
   * timeout has ALREADY spent the full page timeout auto-waiting for the
   * element, so retrying spends it again for an almost certainly identical
   * result. `iris run "click #missing"` took ~92s instead of ~30s purely from
   * retries (issue #75). Fast-failing faults like a connection reset stay
   * retryable — they cost little and genuinely can succeed on a second attempt.
   */
  private isNonRetryableError(error: Error): boolean {
    // A failed assertion describes the page as it is; re-reading it cannot
    // change the answer, and each retry would wait out the timeout again.
    if (error instanceof AssertionFailedError) {
      return true;
    }

    const message = error.message.toLowerCase();

    // Don't retry on certain types of errors
    const nonRetryablePatterns = [
      'invalid url',
      'navigation blocked',
      'browser has been closed',
      'page has been closed',
      'element is read-only',
      // Note: Playwright never emits "element not found" — a missing selector
      // surfaces as the timeout matched by the regex below. Kept for any
      // non-Playwright caller that does raise it.
      'element not found',
      'net::err_blocked_by_client',
      'net::err_network_timeout',
    ];

    // Patterns needing structure rather than a substring. Tested against the
    // original message; the `i` flag makes the lowercasing above irrelevant.
    const nonRetryableExpressions = [
      // "page.click: Timeout 30000ms exceeded." — the ordinary missing-selector
      // failure, and equally a navigation that already waited out its timeout.
      /timeout \d+ms exceeded/i,
      // An ambiguous selector resolves to N elements every single time.
      /strict mode violation/i,
    ];

    return (
      nonRetryablePatterns.some((pattern) => message.includes(pattern)) ||
      nonRetryableExpressions.some((expression) => expression.test(error.message))
    );
  }

  /**
   * Wait for the specified delay.
   */
  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
