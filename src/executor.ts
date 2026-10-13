import { Browser, ElementHandle, Frame, Locator, Page, Request, errors } from 'playwright';
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
  MIN_SECRET_LENGTH,
  looksLikeReference,
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

/**
 * Whether a failed action may be tried again (#296). A click or fill is never repeated:
 * it may already have reached the page (a form submitted, an order placed). Playwright
 * already retries everything that proves nothing was dispatched (a detached element is
 * re-resolved until the timeout), and real Chromium resolves `page.click` when the
 * handler throws, the document is replaced or the page navigates away. So an error that
 * does reach here is a timeout, a protocol or target error mid-dispatch, or unknown.
 * Navigate (a GET) and asserts (reads) keep the general rules.
 */
function mayRepeat(action: Action): boolean {
  // Named, not "anything but click and fill": a new action type stays unretried until
  // someone decides it is safe to repeat.
  return action.type === 'navigate' || action.type === 'assert';
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

/** How long `element_absent` waits for the network to go idle before judging (#504). */
const ABSENT_SETTLE_MS = 5000;
/** How long the element must stay absent on the settled page (#504). */
const ABSENT_WINDOW_MS = 2000;
/** No request in flight for this long is a settled page (as Playwright's networkidle). */
const QUIET_MS = 500;

/** Requests in flight per page, from the first action IRIS ran there (#504). */
const inFlight = new WeakMap<Page, { requests: Set<Request>; quietSince: number }>();

function trackRequests(page: Page): void {
  if (inFlight.has(page) || typeof page.on !== 'function') return; // mocked pages
  const state = { requests: new Set<Request>(), quietSince: performance.now() };
  inFlight.set(page, state);
  // By identity, not a count: a request that began before tracking must not cancel out
  // one an action started when it finishes (codex review).
  const done = (request: Request) => {
    if (state.requests.delete(request) && state.requests.size === 0) {
      state.quietSince = performance.now();
    }
  };
  page.on('request', (request) => void state.requests.add(request));
  page.on('requestfinished', done);
  page.on('requestfailed', done);
}

/** Resolves once no request has been in flight for `QUIET_MS`, or after `capMs`. */
async function waitForQuiet(page: Page, capMs: number): Promise<void> {
  const state = inFlight.get(page);
  if (!state) return;
  const deadline = performance.now() + capMs;
  while (performance.now() < deadline) {
    if (state.requests.size === 0 && performance.now() - state.quietSince >= QUIET_MS) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** `path` is `prefix` or below it, at segment boundaries; `/` is the root only. */
function pathWithin(path: string, prefix: string): boolean {
  const p = prefix.replace(/\/+$/, '');
  if (p === '') return path === '/' || path === '';
  return path === p || path === p + '/' || path.startsWith(p + '/');
}

/**
 * Whether `url` matches an `url_matches` target (#504). Never a substring of the whole href,
 * which let `example.com` match `https://evil.test/?r=example.com` and `/` match every URL:
 * - an absolute http(s) URL: same origin, a path prefix at segment boundaries, and its
 *   query and hash when it has them;
 * - `/path`: the path or below it (`/` is the root only);
 * - `#route`: the hash starts with it;
 * - a host (`example.com`, `example.com/cart`): the hostname or a subdomain, and the path;
 * - any other token (`checkout-complete`): whole segments of the path or of a hash route.
 */
export function urlMatches(url: URL, target: string): boolean {
  const t = target.trim();
  if (t === '') return false; // no URL at all (codex review)
  if (/^https?:\/\//i.test(t)) return matchesAbsolute(url, t);
  if (t.startsWith('/')) return pathWithin(url.pathname, t);
  if (t.startsWith('#')) return url.hash.startsWith(t);
  return looksLikeHost(t) ? matchesHost(url, t) : matchesSegments(url, t);
}

/** `example.com` or `example.com/cart`: a dotted first segment with no spaces. */
const looksLikeHost = (target: string): boolean => /^[^/\s]*\.[^/\s]*(\/|$)/.test(target);

/** A part the target leaves empty matches anything; a given one must be equal. */
const emptyOrEqual = (want: string, got: string): boolean => want === '' || want === got;

/** An absolute target: same origin, a path prefix, and its query and hash when it has them. */
function matchesAbsolute(url: URL, target: string): boolean {
  if (!URL.canParse(target)) return false;
  const want = new URL(target);
  return (
    url.origin === want.origin &&
    pathWithin(url.pathname, want.pathname) &&
    emptyOrEqual(want.search, url.search) &&
    emptyOrEqual(want.hash, url.hash)
  );
}

/** `example.com[/path]`: the hostname or a subdomain, and the path when one is given. */
function matchesHost(url: URL, target: string): boolean {
  const [host, ...rest] = target.split('/');
  const h = host.toLowerCase();
  if (url.hostname !== h && !url.hostname.endsWith('.' + h)) return false;
  return rest.length === 0 || pathWithin(url.pathname, '/' + rest.join('/'));
}

/**
 * Any other token: whole segments of the path, or of a hash route (`#/checkout`) without
 * the route's own query (codex review).
 */
function matchesSegments(url: URL, target: string): boolean {
  const segments = (s: string) => '/' + s.split('/').filter(Boolean).join('/') + '/';
  const token = segments(target);
  return (
    segments(url.pathname).includes(token) ||
    segments(url.hash.replace(/^#!?/, '').split('?')[0]).includes(token)
  );
}

/**
 * What a field holds now (input value, else its text), read for at most a second; `null` when
 * the element is gone (detached, its page closed), so its handle can be released.
 */
async function readField(field: ElementHandle): Promise<string | null> {
  return withPageTimeout(
    field.inputValue().catch(() =>
      field.textContent().then(
        (t) => t ?? '',
        () => null,
      ),
    ),
    '',
    1_000,
  );
}

/** At most this many filled fields are kept for `refreshFieldValues`; the oldest go first. */
const MAX_SECRET_FIELDS = 50;

/**
 * The security origin of the document an element is in (#513): `self.origin`, not the
 * frame's URL, since a sandboxed iframe without `allow-same-origin` has an opaque origin
 * (`null`) whatever its URL (codex review). `undefined` when it cannot be read in time, which
 * a bound reference refuses. A string expression, so coverage instrumentation never reaches
 * the page. `self.origin` is writable by the document's own script, so a sandboxed document
 * served by the bound origin can pass; only the bound site controls that script (see
 * CLAUDE.md, Credential References).
 */
async function effectiveOrigin(handle: ElementHandle): Promise<string | undefined> {
  const frame = await handle.ownerFrame();
  if (!frame) return undefined;
  // The URL's origin is the browser's and cannot be faked by the page; `self.origin` catches
  // an opaque (sandboxed) document but is writable by page script. Both must agree, so a
  // page lying about either is refused, never let through (codex review).
  const fromDocument = await documentOrigin(frame);
  if (fromDocument === 'null') return 'null'; // opaque: named as such in the refusal
  return fromDocument === urlOrigin(frame.url()) ? fromDocument : undefined;
}

/** `self.origin` of a frame's document, read for at most a second. */
async function documentOrigin(frame: Frame): Promise<string | undefined> {
  const origin = await withPageTimeout(
    frame.evaluate('self.origin').catch(() => undefined),
    undefined,
    1_000,
  );
  return typeof origin === 'string' ? origin : undefined;
}

const urlOrigin = (url: string) => (URL.canParse(url) ? new URL(url).origin : undefined);

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
  /**
   * The fields it typed them into (#513), read again by `refreshFieldValues`: a field can
   * hold a form of the value the scrub never saw (a `maxlength` prefix, a page rewrite).
   */
  private secretFieldHandles: ElementHandle[] = [];
  /** The page each kept handle belongs to, so one close listener per page releases them. */
  private readonly secretFieldPages = new WeakMap<ElementHandle, Page>();
  private readonly watchedPages = new WeakSet<Page>();
  /**
   * Everything those fields were seen holding, cut by `redactSecrets` too.
   * ponytail: kept for the executor's life like `resolvedSecrets`, so it grows with each
   * distinct value seen; cap it if one session ever reads thousands.
   */
  private readonly fieldValues = new Set<string>();
  /** Policy handles kept for those readers, not disposed after their action. */
  private readonly retainedHandles = new WeakSet<ElementHandle>();

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
    // A launch already in flight is joined, not repeated (#383): two concurrent
    // createPage() calls both saw no browser, both launched, and `this.browser` kept only
    // the last, orphaning the first Chromium.
    if (this.launching) return this.launching;
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
    target?: ElementHandle,
  ): Promise<ExecutionResult> {
    // Requests an action starts are counted from the first action on the page, so a later
    // element_absent can wait for them (#504).
    trackRequests(page);
    // The element the agent policy read (#530): a click or fill goes to it, not to the
    // selector, which the page could have pointed at another element since. Disposed after.
    try {
      return await this.runAction(action, page, secrets, target);
    } finally {
      // Kept when a reference fill keeps reading the field through it (#513).
      if (target && !this.retainedHandles.has(target))
        await target.dispose().catch(() => undefined);
    }
  }

  private async runAction(
    action: Action,
    page: Page,
    secrets: SecretSource,
    target: ElementHandle | undefined,
  ): Promise<ExecutionResult> {
    if (!page) {
      throw new Error('Page is null or undefined');
    }

    const startTime = Date.now();
    let lastError: Error | null = null;

    // Try initial execution + retries
    for (let attempt = 0; attempt <= this.options.retryAttempts; attempt++) {
      try {
        await this.performAction(action, page, secrets, target);

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
        if (this.isNonRetryableError(lastError) || !mayRepeat(action)) {
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
      error: this.redactError(action, lastError?.message || 'Unknown error'),
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
    return scrubValues(text, [...this.resolvedSecrets, ...this.fieldValues]);
  }

  /**
   * A fill whose text is a credential reference (#513): the element it goes to is resolved
   * first (the policy's handle, else the selector's), so a binding is checked against that
   * element's own frame, iframes included, and the value is typed into that same element.
   * The handle is kept for `refreshFieldValues`, which reads the element itself: replaying
   * the selector misses a field whose id changed or that sits in a frame.
   */
  private async fillFromReference(
    action: Extract<Action, { type: 'fill' }>,
    page: Page,
    secrets: SecretSource,
    target?: ElementHandle,
  ): Promise<void> {
    // Strict, like page.fill (PR bot): two matches refuse rather than type into the first.
    const handle =
      target ??
      (await page
        .locator(action.selector)
        .elementHandle({ timeout: this.options.timeout ?? EXECUTOR_DEFAULTS.timeout }));
    if (!handle) throw new Error(`No element matches ${action.selector}`);
    let value: string;
    try {
      ({ value } = resolveFillText(action.text, secrets, await effectiveOrigin(handle)));
      this.resolvedSecrets.add(value);
      await handle.fill(value);
    } catch (error) {
      // Our own handle goes now; a policy handle is disposed by executeAction.
      if (!target) await handle.dispose().catch(() => undefined);
      throw error;
    }
    this.keepSecretField(handle, page);
    // Read what the field holds now (PR bot): a fill followed in the same turn by a submit
    // or the field's removal never reaches a later refresh, and a maxlength prefix would
    // reach the next URL or digest uncut.
    const held = await readField(handle);
    if (held !== null && held.trim().length >= MIN_SECRET_LENGTH) this.fieldValues.add(held);
  }

  /**
   * Keeps a filled field's handle for `refreshFieldValues` (codex review: bounded, and
   * released when gone). A handle already kept is not added twice.
   */
  private keepSecretField(handle: ElementHandle, page: Page): void {
    if (this.secretFieldHandles.includes(handle)) return;
    this.retainedHandles.add(handle);
    this.secretFieldHandles.push(handle);
    this.secretFieldPages.set(handle, page);
    // A page that closes takes its fields with it: release their handles then, not at the
    // next refresh. Handles kept into a closed page made browser.close() take tens of
    // seconds, or hang (found by this PR's suite). One listener per page (codex review).
    if (!this.watchedPages.has(page)) {
      this.watchedPages.add(page);
      page.once('close', () => {
        for (const h of this.secretFieldHandles.filter(
          (x) => this.secretFieldPages.get(x) === page,
        )) {
          this.releaseSecretField(h);
        }
      });
    }
    for (const old of this.secretFieldHandles.splice(
      0,
      Math.max(0, this.secretFieldHandles.length - MAX_SECRET_FIELDS),
    )) {
      void old.dispose().catch(() => undefined);
    }
  }

  private releaseSecretField(handle: ElementHandle): void {
    this.secretFieldHandles = this.secretFieldHandles.filter((h) => h !== handle);
    void handle.dispose().catch(() => undefined);
  }

  /**
   * Reads what the fields filled from credential references hold now (#513), so the next
   * `redactSecrets` cuts that too: call it before reading the page for a model. Values
   * shorter than `MIN_SECRET_LENGTH` are not cut (they would cut every match); a field that
   * cannot be read (gone, detached) is skipped. Each read is bounded. Values read earlier
   * stay (PR bot): a read that times out must not un-redact what the page may still show.
   */
  async refreshFieldValues(): Promise<void> {
    const held = await Promise.all(this.secretFieldHandles.map((h) => readField(h)));
    // A field that is gone has nothing to show: release its handle.
    const gone = this.secretFieldHandles.filter((_, i) => held[i] === null);
    this.secretFieldHandles = this.secretFieldHandles.filter((_, i) => held[i] !== null);
    for (const handle of gone) void handle.dispose().catch(() => undefined);
    for (const v of held) {
      if (v !== null && v.trim().length >= MIN_SECRET_LENGTH) this.fieldValues.add(v);
    }
  }

  /**
   * The fields on `page` that hold a value this executor typed from a credential reference
   * (#352), for a screenshot to mask (#312): a field that is not `type=password` shows it.
   * A fill can target an `input`, a `textarea` or a contenteditable element (codex review),
   * and a field holding the value among other text still shows it. Bounded: the first 100
   * fields, each read for at most a second; one that cannot be read is masked, since it
   * might hold one, and so is every field past the first 100 (PR bot: they were left
   * unmasked). `null` when the fields cannot even be listed (a hung page): the caller
   * must not take a screenshot it cannot mask.
   */
  async secretFields(page: Page): Promise<Locator[] | null> {
    // What the fields were seen holding too (PR bot): a maxlength field shows a prefix.
    const secrets = [...this.resolvedSecrets, ...this.fieldValues];
    if (secrets.length === 0) return [];
    // Every frame (PR bot): a fill can target a field inside an iframe, and the screenshot
    // renders it.
    const lists = await withPageTimeout(
      Promise.all(
        page
          .frames()
          .map((frame) =>
            frame
              .locator('input, textarea, [contenteditable]:not([contenteditable="false"])')
              .all(),
          ),
      ),
      null,
      // A frame detaching or navigating mid-listing rejects: unlisted, so no screenshot.
    ).catch(() => null);
    if (lists === null) return null;
    const all = lists.flat();
    const fields = all.slice(0, 100);
    const read = (field: Locator) =>
      field
        .inputValue({ timeout: 1_000 })
        .catch(() => field.textContent({ timeout: 1_000 }).then((text) => text ?? ''));
    const held = await Promise.all(
      fields.map((field) =>
        read(field).then(
          (value) => secrets.some((secret) => value.includes(secret)),
          () => true,
        ),
      ),
    );
    return [...fields.filter((_, i) => held[i]), ...all.slice(100)];
  }

  /**
   * An error message as a result may carry it (#352), cut only here, after the retry
   * decision read the original. Any action's error may quote the page (Playwright
   * previews the element it resolved, attributes included, and a page can reflect a
   * typed value), and a fill's call log quotes what it typed (`- fill("…")`).
   */
  private redactError(action: Action, message: string): string {
    const redacted = this.redactSecrets(message);
    // ponytail: a literal under 4 characters is left, or cutting it would mangle every
    // message ("e<redacted>ceeded"); a value that must not leak belongs in a reference.
    // A reference is a name, and its error must say which one.
    return action.type === 'fill' && action.text.length >= 4 && !looksLikeReference(action.text)
      ? scrubValues(redacted, [action.text])
      : redacted;
  }

  /**
   * Get current page context (URL, title, timestamp).
   */
  async getPageContext(page: Page): Promise<PageContext> {
    const timestamp = Date.now();

    try {
      // A GET form can put a typed value in the URL (#352).
      const url = this.redactSecrets(page.url());
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
        // A page may title itself with what was typed ("<query> — Search").
        title: title === undefined ? undefined : this.redactSecrets(title),
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
    // Filled fields' handles (#513) die with the browser; drop them first.
    for (const handle of this.secretFieldHandles.splice(0)) {
      await handle.dispose().catch(() => undefined);
    }
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
  private async performAction(
    action: Action,
    page: Page,
    secrets: SecretSource,
    target?: ElementHandle,
  ): Promise<void> {
    switch (action.type) {
      case 'click':
        // A handle the page detached since the check fails here, rather than the click
        // landing on what replaced it.
        await (target ? target.click() : click(page, action.selector));
        break;

      case 'fill': {
        // Resolved here and nowhere else: the action (and so the result, history
        // and the model's view of prior actions) keeps the reference (#352).
        if (!looksLikeReference(action.text)) {
          const { value } = resolveFillText(action.text, secrets);
          await (target ? target.fill(value) : typeText(page, action.selector, value));
          break;
        }
        await this.fillFromReference(action, page, secrets, target);
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
        // Absence is judged on a settled page (#504): network idle (bounded), then it
        // must stay absent for a window. A one-second glance passed `[click Submit,
        // element_absent .error]` when a slow validation request rendered the error later.
        // Our own count, not `networkidle`: that is a lifecycle state Playwright keeps, so
        // a page idle before the click read as settled with the click's request in flight.
        await waitForQuiet(page, ABSENT_SETTLE_MS); // a page that never idles is judged as is
        holds = !(await this.isVisible(page.locator(action.target).first(), ABSENT_WINDOW_MS));
        break;

      case 'url_matches':
        // Auto-waits like the other kinds. A single synchronous read races an
        // async URL change — an SPA route transition or redirect kicked off by a
        // preceding click lands after this line, producing a false negative.
        // Matched against the parsed URL, not as a substring of the href (#504).
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
   * Whether the page URL comes to match `target` (`urlMatches`) within `timeout`.
   *
   * Uses Playwright's own URL wait so a redirect or SPA route change that is
   * still in flight is given the same grace the visibility checks get. A timeout
   * means "it never matched", which is an answer, not an error.
   */
  private async urlBecomes(page: Page, target: string, timeout: number): Promise<boolean> {
    // A closed page still reports its last URL, which would pass (#240).
    if (page.isClosed()) {
      throw new Error('url_matches: page has been closed');
    }
    if (urlMatches(new URL(page.url()), target)) {
      return true; // already there — skip the wait entirely
    }

    try {
      await page.waitForURL((url) => urlMatches(url, target), { timeout });
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
