import * as fs from 'fs';
import { Browser, chromium, Page } from 'playwright';

/**
 * Is a Chromium binary actually on disk? A path resolve and a stat — no process
 * is spawned (issue #194).
 *
 * Deliberately cheap, because it runs on a call that must stay fast. It answers
 * "is the browser installed", NOT "will it launch": a binary present but unable
 * to start — missing shared libraries, a blocked sandbox — still passes here.
 * Anything needing proof of launch has to actually launch one, which is why
 * #192's container healthcheck calls `chromium.launch()` directly rather than
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
 * Launch a Chromium browser instance.
 *
 * @throws a message naming `npx playwright install chromium` when the browser
 * binary is missing — see {@link launchBrowser} internals and issue #79.
 */
export async function launchBrowser(options: BrowserLaunchOptions = {}): Promise<Browser> {
  try {
    return await chromium.launch({
      headless: options.headless ?? true,
      slowMo: options.slowMo ?? 0,
      // Playwright >=1.61 removed the deprecated `devtools` launch option; this
      // Chromium arg is its documented equivalent.
      args: options.devtools ? ['--auto-open-devtools-for-tabs'] : [],
    });
  } catch (error) {
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
 * Create a new page in the given browser.
 */
export async function newPage(browser: Browser): Promise<Page> {
  return await browser.newPage();
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
