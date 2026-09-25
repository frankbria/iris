import * as fs from 'fs';
import { Browser, BrowserContext, BrowserContextOptions, chromium, Page } from 'playwright';

/**
 * Is a Chromium binary actually on disk? A path resolve and a stat — no process
 * is spawned (issue #194).
 *
 * Deliberately cheap, because it runs on a call that must stay fast. It answers
 * "is the browser installed", NOT "will it launch": a binary present but unable
 * to start — missing shared libraries, a blocked sandbox — still passes here.
 * Anything needing proof of launch has to actually launch one, which is why
 * #192's staging deploy launches one through {@link launchBrowser} rather than
 * relying on this.
 *
 * `executablePath()` computes a path from `PLAYWRIGHT_BROWSERS_PATH` and does
 * not throw when nothing is installed (verified against playwright 1.62), so
 * existence must be checked separately — the path alone proves nothing.
 *
 * Calls `chromium.executablePath()` inline rather than through a local wrapper:
 * a wrapper would be invoked via its module-internal binding, which
 * `jest.spyOn` cannot intercept, whereas a property access on playwright's own
 * `chromium` object can be. Fewer moving parts and testable.
 */
export function chromiumIsInstalled(): boolean {
  try {
    return fs.existsSync(chromium.executablePath());
  } catch {
    // A registry or resolution failure is indistinguishable from "not usable"
    // for this caller, and this probe must never throw into a request path.
    return false;
  }
}

export interface BrowserLaunchOptions {
  headless?: boolean;
  devtools?: boolean;
  slowMo?: number;
}

/**
 * Context options every IRIS page gets (issue #331). Pages are untrusted — in
 * hosted mode they are whatever a customer points us at — so nothing they do
 * may write to disk, outlive the page, or gain a capability without a prompt.
 */
const HARDENED_CONTEXT_OPTIONS = {
  acceptDownloads: false,
  serviceWorkers: 'block',
  permissions: [],
} as const satisfies BrowserContextOptions;

/**
 * Launch a Chromium browser instance. The only place in `src/` that starts one:
 * the CLI executor, the visual runner and the a11y runner all come through here
 * (issue #331, enforced by `browser-hardening.test.ts`).
 *
 * Sandboxed unless `IRIS_CHROMIUM_SANDBOX=0`: Playwright appends `--no-sandbox`
 * to every launch that does not ask for `chromiumSandbox: true`. The opt-out
 * exists for hosts that cannot provide a sandbox and only run trusted pages.
 *
 * Playwright's own SIGINT/SIGTERM/SIGHUP handlers are off: they close every
 * browser the moment a signal lands, underneath the shutdown `iris connect`
 * and `iris watch` run themselves. Nothing is orphaned without them — Chromium
 * exits when its `--remote-debugging-pipe` parent goes away.
 *
 * @throws a message naming `npx playwright install chromium` when the browser
 * binary is missing (issue #79), or naming the opt-out when the host cannot
 * sandbox Chromium (issue #331).
 */
export async function launchBrowser(options: BrowserLaunchOptions = {}): Promise<Browser> {
  try {
    return await chromium.launch({
      headless: options.headless ?? true,
      slowMo: options.slowMo ?? 0,
      // Playwright >=1.61 removed the deprecated `devtools` launch option; this
      // Chromium arg is its documented equivalent.
      args: options.devtools ? ['--auto-open-devtools-for-tabs'] : [],
      chromiumSandbox: process.env.IRIS_CHROMIUM_SANDBOX !== '0',
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
  } catch (error) {
    // Playwright's banner, then Chromium's own. Seen under Docker's default
    // seccomp profile and Ubuntu's AppArmor user-namespace restriction.
    if (error instanceof Error && /sandboxing failed|No usable sandbox/i.test(error.message)) {
      throw new Error(
        'Chromium could not start its sandbox on this host. Allow unprivileged user ' +
          'namespaces (in Docker: a seccomp profile that permits them), or set ' +
          'IRIS_CHROMIUM_SANDBOX=0 to run unsandboxed — only for pages you trust. ' +
          `Original error: ${error.message}`,
      );
    }
    // Installing iris does not guarantee the browser binaries: Playwright
    // downloads them from a postinstall script, which pnpm skips by default and
    // which `--ignore-scripts` and hardened CI images disable outright. The
    // first `iris run` then died on Playwright's raw "Executable doesn't exist"
    // banner, which reads like a broken install rather than one missing step
    // (issue #79).
    //
    // Narrow on purpose: a sandbox or permissions failure keeps its own
    // diagnostics, which this message would only obscure.
    if (error instanceof Error && /Executable doesn't exist/i.test(error.message)) {
      // The resolved cache path goes in the MESSAGE, not just `cause`.
      //
      // `cause` does not survive the trip: ActionExecutor.launchBrowser rebuilds
      // the error from `.message`, createPage rebuilds it again, and the
      // JSON-RPC layer serialises `message` alone — so a value parked on `cause`
      // is stripped before any user sees it. The message is the one field every
      // layer carries, so the diagnostic belongs there.
      //
      // It matters because the two failures look identical and have opposite
      // fixes: browsers genuinely missing (run the command) versus
      // PLAYWRIGHT_BROWSERS_PATH pointing somewhere wrong (running the command
      // installs to the default cache and changes nothing). The path is what
      // tells them apart.
      const expectedPath = error.message.match(/Executable doesn't exist at (\S+)/i)?.[1];
      const actionable = new Error(
        'Playwright browsers are not installed. Run: npx playwright install chromium' +
          (expectedPath ? ` (expected the browser at ${expectedPath})` : ''),
      );
      // Kept as well, for programmatic callers that want the untouched original.
      // Assigned rather than passed to the constructor: `cause` is ES2022 and
      // this project's tsconfig targets ES2020, so the two-argument Error
      // overload isn't in the type lib. It exists at runtime on Node >=20.9,
      // which package.json already requires.
      (actionable as Error & { cause?: unknown }).cause = error;
      throw actionable;
    }
    throw error;
  }
}

/**
 * Open a browser context with the hardened options applied last, so a caller's
 * `acceptDownloads` or `permissions` cannot loosen them. Other options
 * (viewport, locale, ...) pass through.
 */
export async function newHardenedContext(
  browser: Browser,
  options: BrowserContextOptions = {},
): Promise<BrowserContext> {
  return await browser.newContext({ ...options, ...HARDENED_CONTEXT_OPTIONS });
}

/**
 * Create a new page, in its own hardened context, in the given browser.
 */
export async function newPage(browser: Browser): Promise<Page> {
  return await browser.newPage(HARDENED_CONTEXT_OPTIONS);
}

/**
 * Close the given browser instance.
 */
export async function closeBrowser(browser: Browser): Promise<void> {
  await browser.close();
}

/**
 * Navigate the page to the specified URL.
 */
export async function navigate(page: Page, url: string): Promise<void> {
  await page.goto(url);
}

/**
 * Click the element matching selector.
 */
export async function click(page: Page, selector: string): Promise<void> {
  await page.click(selector);
}

/**
 * Fill the element matching selector with text.
 */
export async function typeText(page: Page, selector: string, text: string): Promise<void> {
  await page.fill(selector, text);
}

/**
 * Take a screenshot of the page. Returns a Buffer by default.
 *
 * KEPT DELIBERATELY, though no other `src` module calls it (issue #81 listed it
 * as dead). Visual capture has its own stabilising pipeline in
 * `visual/capture.ts` and does not need this, but it sits alongside
 * click/typeText as part of this module's small exported browser vocabulary,
 * and it is two lines. Deleting an exported helper to save two lines is a
 * breaking change with no upside.
 */
export async function takeScreenshot(page: Page): Promise<Buffer> {
  return await page.screenshot();
}
