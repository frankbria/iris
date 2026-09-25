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
    // Only recognised failures get guidance; anything else keeps its own
    // diagnostics, which our message would obscure.
    const other = new Error('Failed to launch: EACCES /usr/bin/chrome');
    mockLaunch.mockRejectedValue(other);

    await expect(launchBrowser()).rejects.toBe(other);
  });

  it('puts the resolved cache path in the message, where it survives re-wrapping', async () => {
    mockLaunch.mockRejectedValue(missingExecutableError());

    // `cause` does not survive: the executor, createPage, and the JSON-RPC layer
    // each rebuild the error from `.message` alone. The path has to ride there.
    await expect(launchBrowser()).rejects.toThrow(
      /expected the browser at \/home\/u\/\.cache\/ms-playwright\/chromium-1200/,
    );
  });

  it('omits the path clause when Playwright did not state one', async () => {
    mockLaunch.mockRejectedValue(new Error("Executable doesn't exist"));

    const error = await launchBrowser().catch((e) => e);
    expect(error.message).toBe(
      'Playwright browsers are not installed. Run: npx playwright install chromium',
    );
  });

  // The executor is the only non-test caller, so its wrapper is the path every
  // `iris run` / `watch` / `connect` user actually travels.
  it('surfaces guidance AND the path through ActionExecutor', async () => {
    const original = missingExecutableError();
    mockLaunch.mockRejectedValue(original);

    const { ActionExecutor } = await import('../src/executor');
    const executor = new ActionExecutor();

    const error = await executor.launchBrowser().catch((e) => e);

    // Both halves reach the layer users actually read. Asserting on `.message`
    // rather than `.cause` is the point: no production code reads `.cause`.
    expect(error.message).toMatch(/npx playwright install chromium/);
    expect(error.message).toMatch(/expected the browser at \/home\/u\/\.cache/);
    // Still preserved for programmatic callers.
    expect(error.cause).toBe(original);
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

/**
 * Issue #331: launches are sandboxed by default, and hosts that cannot provide
 * one (Docker's default seccomp profile, Ubuntu's AppArmor userns restriction)
 * now fail where they used to silently run unsandboxed. The failure has to say
 * what to do about it.
 */
describe('launchBrowser on a host that cannot sandbox Chromium (issue #331)', () => {
  const saved = process.env.IRIS_CHROMIUM_SANDBOX;
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => {
    if (saved === undefined) delete process.env.IRIS_CHROMIUM_SANDBOX;
    else process.env.IRIS_CHROMIUM_SANDBOX = saved;
  });

  // Both shapes seen in the wild: Playwright's banner (captured from the
  // Playwright image under Docker's default seccomp) and Chromium's own.
  it.each([
    'browserType.launch: Target page, context or browser has been closed\nBrowser logs:\nChromium sandboxing failed!',
    'Failed to launch the browser process!\n[0925/120000.000:FATAL:zygote_host_impl_linux.cc(127)] No usable sandbox!',
  ])('names the fix and the opt-out: %s', async (message) => {
    mockLaunch.mockRejectedValue(new Error(message));

    const error = await launchBrowser().catch((e) => e);
    expect(error.message).toMatch(/sandbox/i);
    expect(error.message).toMatch(/IRIS_CHROMIUM_SANDBOX=0/);
    // The original diagnostics stay in the message: every layer above rebuilds
    // the error from `.message` alone.
    expect(error.message).toContain(message.split('\n')[0]);
  });

  it('requests the sandbox and leaves signal handling to IRIS', async () => {
    mockLaunch.mockResolvedValue({ close: jest.fn() });

    await launchBrowser();
    expect(mockLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        chromiumSandbox: true,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      }),
    );
  });

  it('only the exact value "0" turns the sandbox off', async () => {
    mockLaunch.mockResolvedValue({ close: jest.fn() });

    for (const [value, sandbox] of [
      ['0', false],
      ['false', true],
      ['', true],
    ] as const) {
      process.env.IRIS_CHROMIUM_SANDBOX = value;
      await launchBrowser();
      expect(mockLaunch).toHaveBeenLastCalledWith(
        expect.objectContaining({ chromiumSandbox: sandbox }),
      );
    }
  });
});
