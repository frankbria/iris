import { Browser, Page, errors } from 'playwright';
import { Action } from './translator';
import {
  launchBrowser,
  newPage,
  closeBrowser,
  click,
  typeText,
  BrowserLaunchOptions,
} from './browser';
import { assertNavigationAllowed, UrlPolicyOptions } from './url-policy';
import { installUrlPolicyGuard, guardedGoto } from './url-policy-guard';
import { withPageTimeout } from './page-timeout';
import { isHostedMode } from './hosted';
import {
  CredentialReferenceError,
  envSecrets,
  noSecrets,
  resolveFillText,
  scrubValues,
  SecretSource,
} from './credential-refs';

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

/** Timing defaults for an option the caller leaves unset. The RPC server clamps these too (#338). */
export const EXECUTOR_DEFAULTS = { retryAttempts: 3, retryDelay: 1000, timeout: 30000 } as const;

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
  /** A launch still in progress, so `cleanup()` can wait for it and close what it yields. */
  private launching: Promise<Browser> | null = null;
  /** Values this executor typed from credential references (#352), for `redactSecrets`. */
  private readonly resolvedSecrets = new Set<string>();

  constructor(options: ActionExecutorOptions = {}) {
    this.options = {
      retryAttempts: options.retryAttempts ?? EXECUTOR_DEFAULTS.retryAttempts,
      retryDelay: options.retryDelay ?? EXECUTOR_DEFAULTS.retryDelay,
      timeout: options.timeout ?? EXECUTOR_DEFAULTS.timeout,
      trackContext: options.trackContext ?? true,
      browserOptions: options.browserOptions ?? { headless: true },
      urlPolicy: options.urlPolicy ?? {},
    };
  }

  /**
   * Launch a new browser instance.
   */
  async launchBrowser(): Promise<Browser> {
    const launching = this.launch();
    this.launching = launching;
    try {
      return await launching;
    } finally {
      if (this.launching === launching) this.launching = null;
    }
  }

  private async launch(): Promise<Browser> {
    try {
      const browser = await launchBrowser(this.options.browserOptions);
      this.browser = browser;
      // A crashed or killed Chromium must not stay bound: the next createPage()
      // launches a fresh one instead of failing against the dead one (#240).
      browser.on('disconnected', () => {
        if (this.browser === browser) this.browser = null;
      });
      return browser;
    } catch (error) {
      const wrapped = new Error(
        `Browser launch failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      // Carry the original through. This wrapper keeps only `.message`, so
      // anything the underlying error attached — notably the missing-browser
      // error's `cause`, which holds Playwright's resolved cache path (issue
      // #79) — would otherwise be dropped before it ever reached a CLI user.
      (wrapped as Error & { cause?: unknown }).cause =
        (error as { cause?: unknown })?.cause ?? error;
      throw wrapped;
    }
  }

  /**
   * Create a new page, launching browser if needed.
   */
  async createPage(): Promise<Page> {
    try {
      // isConnected() as well as the 'disconnected' listener: a death before
      // the listener was attached would otherwise stay bound forever.
      if (!this.browser?.isConnected()) {
        await this.launchBrowser();
      }

      const page = await newPage(this.browser!);

      // Enforce the URL policy on EVERY request the page makes, not just the
      // initial navigate action URL. Redirect targets included — Chromium follows
      // a 30x without re-routing it, so the previous inline `route.continue()`
      // here let a public URL redirect straight to a metadata host despite the
      // comment claiming otherwise (issue #148).
      await installUrlPolicyGuard(page, this.options.urlPolicy);

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
   *
   * `secrets` resolves a fill's `{{secret:NAME}}` (#352). Omitted, it is
   * `IRIS_SECRET_<NAME>` locally and nothing under IRIS_HOSTED: the server's
   * environment is the operator's, never a tenant's.
   */
  async executeAction(
    action: Action,
    page: Page,
    secrets: SecretSource = isHostedMode() ? noSecrets : envSecrets(),
  ): Promise<ExecutionResult> {
    if (!page) {
      throw new Error('Page is null or undefined');
    }

    const startTime = Date.now();
    let lastError: Error | null = null;

    // Try initial execution + retries
    for (let attempt = 0; attempt <= this.options.retryAttempts; attempt++) {
      try {
        await this.performAction(action, page, secrets);

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
  async executeActions(
    actions: Action[],
    page: Page,
    secrets?: SecretSource,
  ): Promise<ExecutionResult[]> {
    const results: ExecutionResult[] = [];

    for (const action of actions) {
      const result = await this.executeAction(action, page, secrets);
      results.push(result);
    }

    return results;
  }

  /**
   * `text` with every value this executor typed from a credential reference cut.
   * The page shows what a field holds (an ARIA snapshot includes password fields),
   * so anything read back from the page must pass through this before a model.
   */
  redactSecrets(text: string): string {
    return scrubValues(text, this.resolvedSecrets);
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
        title = await withPageTimeout(page.title(), undefined);
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
    // A cleanup that lands mid-launch would otherwise find no browser yet and
    // leave the one about to arrive running with nothing to close it (#240).
    await this.launching?.catch(() => undefined);
    const browser = this.browser;
    if (browser) {
      try {
        await closeBrowser(browser);
      } catch {
        // Ignore cleanup errors
      } finally {
        // Not a browser launched while this one was closing.
        if (this.browser === browser) this.browser = null;
      }
    }
  }

  /**
   * Perform the actual action on the page.
   */
  private async performAction(action: Action, page: Page, secrets: SecretSource): Promise<void> {
    switch (action.type) {
      case 'click':
        await click(page, action.selector);
        break;

      case 'fill': {
        // Resolved here and nowhere else: the action (and so the result, history
        // and the model's view of prior actions) keeps the reference (#352).
        const { value, fromReference } = resolveFillText(action.text, secrets);
        if (fromReference) this.resolvedSecrets.add(value);
        try {
          await typeText(page, action.selector, value);
        } catch (error) {
          // Playwright's call log quotes what it typed (`- fill("…")`), and this
          // message reaches replies and org-readable history. Literal values too.
          if (error instanceof Error) error.message = scrubValues(error.message, [value]);
          throw error;
        }
        break;
      }

      case 'navigate':
        // Fail fast on a URL that is refused outright, so the caller gets a clear
        // message rather than an aborted request. All RPC/AI/pattern navs funnel
        // through here.
        assertNavigationAllowed(action.url, this.options.urlPolicy);
        // Not `navigate()`/`page.goto` directly: that follows redirects inside
        // Chromium, where the guard cannot see them. guardedGoto walks the chain
        // one vetted hop at a time, as real navigations, so redirects still work
        // and the document URL stays correct.
        await guardedGoto(page, action.url);
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
    // A closed page still reports its last URL, which would pass (#240).
    if (page.isClosed()) {
      throw new Error('url_matches: page has been closed');
    }
    if (page.url().includes(substring)) {
      return true; // already there — skip the wait entirely
    }

    try {
      await page.waitForURL((url) => url.href.includes(substring), { timeout });
      return true;
    } catch (error) {
      if (error instanceof errors.TimeoutError) return false;
      throw error;
    }
  }

  /**
   * Whether a locator becomes visible within `timeout`. A timeout means "not
   * visible", which is an answer, not an error. Anything else — a closed page,
   * a malformed selector — is an error: read as "not visible" it made
   * `element_absent` pass against a dead page (#240).
   */
  private async isVisible(locator: ReturnType<Page['locator']>, timeout: number): Promise<boolean> {
    try {
      await locator.waitFor({ state: 'visible', timeout });
      return true;
    } catch (error) {
      if (error instanceof errors.TimeoutError) return false;
      throw error;
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
    // An unknown or malformed reference stays unknown on every attempt.
    if (error instanceof CredentialReferenceError) {
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
      // guardedGoto's own verdicts. These are deterministic policy decisions —
      // the URL will be just as blocked on the fourth attempt — so without them
      // a blocked navigation burns the full retry budget re-fetching the chain.
      'blocked by navigation policy',
      'redirects to an unparseable location',
      'without settling',
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
