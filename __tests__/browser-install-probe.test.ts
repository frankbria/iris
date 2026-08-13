/**
 * Issue #194: `launchBrowser` claimed a browser had been launched when none had.
 *
 * `createBrowserSession` only constructs an ActionExecutor and returns
 * `page: null`; Chromium starts lazily on the first action. The laziness is
 * deliberate and stays — a client that never acts should not hold a browser.
 * What was wrong was the claim, and the fact that a missing browser surfaced
 * as a failure of whatever action happened to run first rather than as a setup
 * problem.
 *
 * Found because #192's container healthcheck was built on this RPC and could
 * not fail: it reported a container with no browser at all as healthy.
 */
import { chromium } from 'playwright';
import * as browserModule from '../src/browser';

describe('chromiumIsInstalled (issue #194)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('is true when the resolved executable exists on disk', () => {
    // The real installed browser: this suite could not run without one.
    expect(browserModule.chromiumIsInstalled()).toBe(true);
  });

  it('is false when the resolved executable is absent', () => {
    // executablePath() computes a path from PLAYWRIGHT_BROWSERS_PATH and does
    // NOT throw when nothing is installed — verified against playwright 1.62 —
    // so existence has to be checked separately. Pointing it at a path that
    // cannot exist is the cheapest faithful stand-in for "not installed".
    jest
      .spyOn(chromium, 'executablePath')
      .mockReturnValue('/nonexistent-playwright-cache/chromium/chrome');

    expect(browserModule.chromiumIsInstalled()).toBe(false);
  });

  it('is false rather than throwing when the path cannot be resolved at all', () => {
    jest.spyOn(chromium, 'executablePath').mockImplementation(() => {
      throw new Error('registry unavailable');
    });

    expect(browserModule.chromiumIsInstalled()).toBe(false);
  });
});

/**
 * The other half of #194: a missing browser must be attributable to browser
 * setup, not to whatever action happens to run first.
 *
 * Before this, `launchBrowser` returned plain success with no browser present,
 * and the real failure surfaced later as "Page creation failed" on an unrelated
 * navigate — which is how #192's container healthcheck came to report a
 * browser-less container as healthy.
 */
describe('launchBrowser reports a missing browser (issue #194)', () => {
  const { startServer } = jest.requireActual('../src/protocol') as typeof import('../src/protocol');
  const WebSocket = jest.requireActual('ws') as typeof import('ws');

  const rpc = async (port: number, token: string, method: string) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const timer = setTimeout(() => reject(new Error('rpc timeout')), 20000);
      ws.on('open', () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} })));
      ws.on('message', (raw: Buffer) => {
        clearTimeout(timer);
        ws.close();
        resolve(JSON.parse(raw.toString()));
      });
      ws.on('error', (e: Error) => {
        clearTimeout(timer);
        reject(e);
      });
    });

  let server: ReturnType<typeof startServer> | undefined;
  const PORT = 4457;
  const TOKEN = 'issue-194-token';

  afterEach(async () => {
    jest.restoreAllMocks();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
  });

  it('does NOT report plain success when Chromium is absent', async () => {
    jest.spyOn(chromium, 'executablePath').mockReturnValue('/nonexistent-cache/chrome');
    server = startServer(PORT, { authToken: TOKEN });

    const res = await rpc(PORT, TOKEN, 'launchBrowser');

    // Either an rpc error or success:false is acceptable; silently claiming
    // success is what must not happen.
    const result = res.result as { success?: boolean; message?: string } | undefined;
    expect(result?.success).not.toBe(true);
    const text = JSON.stringify(res);
    expect(text).toMatch(/not installed|playwright install/i);
  }, 30000);

  it('reports success when Chromium is present', async () => {
    server = startServer(PORT, { authToken: TOKEN });

    const res = await rpc(PORT, TOKEN, 'launchBrowser');

    const result = res.result as { success?: boolean } | undefined;
    expect(result?.success).toBe(true);
  }, 30000);
});
