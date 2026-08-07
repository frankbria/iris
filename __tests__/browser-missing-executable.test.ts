/**
 * Issue #79: when the Playwright postinstall is skipped — pnpm's default,
 * `--ignore-scripts`, hardened CI — the first `iris run` died with Playwright's
 * raw "Executable doesn't exist" banner and no indication of what to do.
 *
 * Its own file because jest.mock is file-wide, and browser.test.ts drives a real
 * Chromium that must stay unmocked.
 */

const mockLaunch = jest.fn();
jest.mock('playwright', () => ({
  chromium: { launch: mockLaunch },
}));

import { launchBrowser } from '../src/browser';

/** The shape Playwright actually throws, banner and all. */
const missingExecutableError = () =>
  new Error(
    "browserType.launch: Executable doesn't exist at /home/u/.cache/ms-playwright/chromium-1200/chrome-linux/chrome\n" +
      '╔══════════════════════════════════════════════════════╗\n' +
      '║ Looks like Playwright was just installed or updated. ║\n' +
      '║ Please run the following command to download new     ║\n' +
      '║ browsers:                                            ║\n' +
      '║                                                      ║\n' +
      '║     npx playwright install                           ║\n' +
      '╚══════════════════════════════════════════════════════╝',
  );

describe('launchBrowser with missing Playwright browsers (issue #79)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('replaces the raw executable error with the command that fixes it', async () => {
    mockLaunch.mockRejectedValue(missingExecutableError());

    await expect(launchBrowser()).rejects.toThrow(/npx playwright install chromium/);
  });

  it('names the actual problem, not just the remedy', async () => {
    mockLaunch.mockRejectedValue(missingExecutableError());

    await expect(launchBrowser()).rejects.toThrow(/browsers are not installed/i);
  });

  it('keeps the original error reachable as `cause` for debugging', async () => {
    const original = missingExecutableError();
    mockLaunch.mockRejectedValue(original);

    // The install path in Playwright's message is the thing you need when the
    // cache lives somewhere unexpected (PLAYWRIGHT_BROWSERS_PATH), so replacing
    // the message must not discard it.
    await expect(launchBrowser()).rejects.toMatchObject({ cause: original });
  });

  it('passes other launch failures through untouched', async () => {
    // Only the missing-executable case gets rewritten; a sandbox or permission
    // failure keeps its own diagnostics, which our message would obscure.
    const other = new Error('Failed to launch: No usable sandbox!');
    mockLaunch.mockRejectedValue(other);

    await expect(launchBrowser()).rejects.toThrow('Failed to launch: No usable sandbox!');
    await expect(launchBrowser()).rejects.not.toThrow(/npx playwright install/);
  });

  // The executor is the only non-test caller, so its wrapper is the path every
  // `iris run` / `watch` / `connect` user actually travels. It rebuilds the error
  // from `.message` alone, which silently dropped everything below.
  it('surfaces the guidance and the original path through ActionExecutor', async () => {
    const original = missingExecutableError();
    mockLaunch.mockRejectedValue(original);

    const { ActionExecutor } = await import('../src/executor');
    const executor = new ActionExecutor();

    await expect(executor.launchBrowser()).rejects.toThrow(/npx playwright install chromium/);
    // Without propagation the resolved cache path — the thing you need when
    // PLAYWRIGHT_BROWSERS_PATH points somewhere unexpected — dies in the wrapper.
    await expect(executor.launchBrowser()).rejects.toMatchObject({ cause: original });
  });

  it('still returns the browser on the happy path', async () => {
    const browser = { close: jest.fn() };
    mockLaunch.mockResolvedValue(browser);

    await expect(launchBrowser()).resolves.toBe(browser);
    expect(mockLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ headless: true, slowMo: 0, args: [] }),
    );
  });
});
