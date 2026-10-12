/**
 * Real-browser E2E test for `watch --execute` (issue #58 / P0.5).
 *
 * Proves the fix end-to-end: in execute mode the watcher navigates the page to the
 * changed file's `file://` URL before running translated actions, so a DOM-targeting
 * action (`click #target`) hits a real element instead of failing on about:blank.
 *
 * Uses a real Playwright browser, a real translator, and a real chokidar watcher —
 * nothing in the execution path is mocked.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { FileWatcher } from '../../src/watcher';

const HTML = `<!doctype html>
<html><body>
  <button id="target" onclick="this.textContent='clicked'">click me</button>
</body></html>`;

describe('watch --execute real-browser E2E (issue #58)', () => {
  let tempDir: string;
  let htmlFile: string;
  let watcher: FileWatcher;
  let logSpy: jest.SpyInstance;
  let prevDbPath: string | undefined;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-watch-e2e-'));
    htmlFile = path.join(tempDir, 'page.html');
    fs.writeFileSync(htmlFile, HTML);
    // Redirect DB writes to a throwaway path so the test never touches ~/.iris.
    prevDbPath = process.env.IRIS_DB_PATH;
    process.env.IRIS_DB_PATH = path.join(tempDir, 'iris.db');
  });

  afterAll(async () => {
    if (watcher) await watcher.stop();
    if (prevDbPath === undefined) delete process.env.IRIS_DB_PATH;
    else process.env.IRIS_DB_PATH = prevDbPath;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('navigates to the changed file and clicks a real DOM target successfully', async () => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    watcher = new FileWatcher({
      cwd: tempDir,
      patterns: ['*.html'],
      instruction: 'click #target',
      execute: true,
      headless: true,
      debounceMs: 50,
      persistent: true,
    });

    await watcher.start();

    // Wait for chokidar to report ready before mutating the file.
    await waitFor(() => logSpy.mock.calls.some((c) => c.join(' ').includes('watcher ready')));

    // Trigger a real 'change' event.
    fs.writeFileSync(htmlFile, HTML.replace('click me', 'click me now'));

    // The action loop reports full success only if the click actually landed on #target,
    // which requires the page to have navigated to the file (not about:blank).
    await waitFor(() =>
      logSpy.mock.calls.some((c) => c.join(' ').includes('actions completed successfully')),
    );

    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain(`Navigating to ${pathToFileURL(htmlFile).href}`);
    expect(output).toContain('🎉 All 1 actions completed successfully!');

    logSpy.mockRestore();
  }, 60000);
});

// #354: an AI-translated plan runs under the agent policy in `watch --execute` too. A
// stand-in OpenAI plans a click on a "Delete account" button in the watched file.
describe('watch --execute applies the agent policy to an AI plan (#354)', () => {
  const ACCOUNT = `<!doctype html>
<html><body>
  <button id="save">Save</button>
  <button id="wipe" onclick="this.textContent='wiped'">Delete account</button>
</body></html>`;
  let tempDir: string;
  let vendor: Server;
  let watcher: FileWatcher | undefined;
  const saved = {
    key: process.env.OPENAI_API_KEY,
    base: process.env.OPENAI_BASE_URL,
    db: process.env.IRIS_DB_PATH,
  };

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-watch-policy-'));
    fs.writeFileSync(path.join(tempDir, 'account.html'), ACCOUNT);
    process.env.IRIS_DB_PATH = path.join(tempDir, 'iris.db');
    vendor = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const plan = {
          actions: [{ type: 'click', selector: 'body button:nth-of-type(2)' }],
          confidence: 0.9,
        };
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(plan) } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => vendor.listen(0, '127.0.0.1', resolve));
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${(vendor.address() as AddressInfo).port}/v1`;
  });

  afterAll(async () => {
    if (watcher) await watcher.stop();
    await new Promise((resolve) => vendor.close(resolve));
    for (const [k, v] of [
      ['OPENAI_API_KEY', saved.key],
      ['OPENAI_BASE_URL', saved.base],
      ['IRIS_DB_PATH', saved.db],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('refuses the destructive click the model proposed', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      watcher = new FileWatcher({
        cwd: tempDir,
        patterns: ['*.html'],
        instruction: 'tidy up this account page',
        execute: true,
        headless: true,
        debounceMs: 50,
        persistent: true,
      });
      await watcher.start();
      await waitFor(() => logSpy.mock.calls.some((c) => c.join(' ').includes('watcher ready')));
      fs.writeFileSync(path.join(tempDir, 'account.html'), ACCOUNT.replace('Save', 'Save now'));

      await waitFor(() =>
        logSpy.mock.calls.some((c) => c.join(' ').includes('actions completed successfully')),
      );
      const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(output).toMatch(
        /Refused by agent policy: target resolves to an element that looks destructive/,
      );
      expect(output).toContain('0/1 actions completed successfully');
    } finally {
      logSpy.mockRestore();
    }
  }, 60000);
});

/** Poll a predicate until true or timeout. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 45000,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor timed out');
}
