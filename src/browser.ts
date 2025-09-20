import { Browser, chromium, Page } from 'playwright';

export interface BrowserLaunchOptions {
  headless?: boolean;
  devtools?: boolean;
  slowMo?: number;
}

/**
 * Launch a Chromium browser instance.
 */
export async function launchBrowser(options: BrowserLaunchOptions = {}): Promise<Browser> {
  return await chromium.launch({
    headless: options.headless ?? true,
    devtools: options.devtools ?? false,
    slowMo: options.slowMo ?? 0,
  });
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
