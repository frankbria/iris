import { launchBrowser, newPage, closeBrowser, navigate, click, typeText, takeScreenshot } from '../src/browser';

describe('Browser Automation Module', () => {
  let browser: Awaited<ReturnType<typeof launchBrowser>>;
  let page: Awaited<ReturnType<typeof newPage>>;

  beforeAll(async () => {
    browser = await launchBrowser();
    page = await newPage(browser);
  });

  afterAll(async () => {
    await closeBrowser(browser);
  });

  test('navigate to a data URL and check title', async () => {
    const html = `<html><head><title>Test Page</title></head><body></body></html>`;
    await navigate(page, `data:text/html,${encodeURIComponent(html)}`);
    const title = await page.title();
    expect(title).toBe('Test Page');
  });

  test('click updates attribute on element', async () => {
    const html = `<html><body><button id="btn" onclick="document.body.setAttribute('data-clicked','true')">Click</button></body></html>`;
    await navigate(page, `data:text/html,${encodeURIComponent(html)}`);
    await click(page, '#btn');
    const clicked = await page.evaluate(() => document.body.getAttribute('data-clicked'));
    expect(clicked).toBe('true');
  });

  test('typeText fills input value', async () => {
    const html = `<html><body><input id="inp"/></body></html>`;
    await navigate(page, `data:text/html,${encodeURIComponent(html)}`);
    await typeText(page, '#inp', 'hello');
    const value = await page.$eval('#inp', (el: Element) => (el as HTMLInputElement).value);
    expect(value).toBe('hello');
  });

  test('takeScreenshot returns a buffer of PNG data', async () => {
    const html = `<html><body><div style="width:50px;height:50px;background:red"></div></body></html>`;
    await navigate(page, `data:text/html,${encodeURIComponent(html)}`);
    const buffer = await takeScreenshot(page);
    // PNG files start with the following signature
    expect(buffer.slice(0, 8)).toEqual(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  });
});
