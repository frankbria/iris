import { Browser, chromium, Page } from 'playwright';

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
 */
export async function takeScreenshot(page: Page): Promise<Buffer> {
  return await page.screenshot();
}
