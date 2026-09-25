/**
 * Issue #331: every Chromium IRIS starts goes through one hardened factory.
 *
 * Playwright appends `--no-sandbox` unless `chromiumSandbox: true`, so hostile
 * pages used to render in an unsandboxed renderer. These tests drive a real
 * Chromium and read what was actually spawned, rather than asserting on the
 * options object we pass — the options are the claim, the argv is the fact.
 */
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { AddressInfo } from 'net';
import { Browser, chromium } from 'playwright';
import { launchBrowser, newHardenedContext, newPage } from '../src/browser';

/**
 * Command lines of this process's direct children.
 *
 * Chromium rewrites its own argv into one space-joined string, so callers
 * match a flag as a substring rather than an array element. Linux-only (/proc).
 */
function childCommandLines(): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
      // comm (field 2) may contain spaces or parens; ppid follows the last ')'.
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      if (ppid === process.pid) {
        out.push(fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8').replace(/\0/g, ' '));
      }
    } catch {
      // The process exited between readdir and read.
    }
  }
  return out;
}

/** Launch, and return the command line of the Chromium that launch spawned. */
async function launchAndCapture(
  launch: () => Promise<Browser>,
): Promise<{ browser: Browser; commandLine: string }> {
  const before = new Set(childCommandLines());
  const browser = await launch();
  const spawned = childCommandLines().filter(
    (cmd) => !before.has(cmd) && cmd.includes('--remote-debugging-pipe'),
  );
  expect(spawned).toHaveLength(1);
  return { browser, commandLine: spawned[0] };
}

const describeLinux = process.platform === 'linux' ? describe : describe.skip;

describeLinux('launchBrowser: Chromium sandbox (issue #331)', () => {
  const saved = process.env.IRIS_CHROMIUM_SANDBOX;
  afterEach(() => {
    if (saved === undefined) delete process.env.IRIS_CHROMIUM_SANDBOX;
    else process.env.IRIS_CHROMIUM_SANDBOX = saved;
  });

  it('negative control: a raw Playwright launch really does pass --no-sandbox', async () => {
    // Proves the probe can see the flag; without this, the next test would
    // pass just as happily against a probe that never finds anything.
    const { browser, commandLine } = await launchAndCapture(() => chromium.launch());
    await browser.close();
    expect(commandLine).toMatch(/--no-sandbox\b/);
  });

  it('spawns Chromium without --no-sandbox', async () => {
    const { browser, commandLine } = await launchAndCapture(() => launchBrowser());
    await browser.close();
    expect(commandLine).not.toMatch(/--no-sandbox\b/);
  });

  it('IRIS_CHROMIUM_SANDBOX=0 is an explicit opt-out for hosts that cannot sandbox', async () => {
    process.env.IRIS_CHROMIUM_SANDBOX = '0';
    const { browser, commandLine } = await launchAndCapture(() => launchBrowser());
    await browser.close();
    expect(commandLine).toMatch(/--no-sandbox\b/);
  });

  it('does not install Playwright signal handlers over the server’s own', async () => {
    // Playwright's handlers close every browser on SIGINT/SIGTERM/SIGHUP while
    // `iris connect` is still draining (cli.ts installs its own shutdown).
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
    const before = signals.map((s) => process.listenerCount(s));
    const browser = await launchBrowser();
    const during = signals.map((s) => process.listenerCount(s));
    await browser.close();
    expect(during).toEqual(before);
  });
});

describe('newHardenedContext (issue #331)', () => {
  let browser: Browser;
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    browser = await launchBrowser();
    // A real http origin: service workers need a secure context (127.0.0.1
    // qualifies), which data: URLs are not.
    server = http.createServer((req, res) => {
      if (req.url === '/sw.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end('');
      } else if (req.url === '/file') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('payload');
      } else {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<a id="dl" download="x.txt" href="/file">download</a>');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });

  it('refuses downloads', async () => {
    const context = await newHardenedContext(browser);
    const page = await context.newPage();
    await page.goto(base);
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#dl')]);
    expect(await download.failure()).toMatch(/acceptDownloads/);
    await context.close();
  });

  it('blocks service worker registration', async () => {
    // Playwright's "block" replaces register() with a resolving no-op, so the
    // honest check is whether a registration exists afterwards.
    const context = await newHardenedContext(browser);
    const page = await context.newPage();
    await page.goto(base);
    const registrations = await page.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js').catch(() => undefined);
      return (await navigator.serviceWorker.getRegistrations()).length;
    });
    expect(registrations).toBe(0);
    await context.close();
  });

  it('keeps its hardening when the caller passes conflicting options', async () => {
    const context = await newHardenedContext(browser, {
      acceptDownloads: true,
      permissions: ['geolocation'],
      viewport: { width: 400, height: 300 },
    });
    const page = await context.newPage();
    await page.goto(base);
    const geolocation = await page.evaluate(
      async () => (await navigator.permissions.query({ name: 'geolocation' })).state,
    );
    expect(geolocation).not.toBe('granted');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#dl')]);
    expect(await download.failure()).toMatch(/acceptDownloads/);
    // Non-security options still pass through.
    expect(page.viewportSize()).toEqual({ width: 400, height: 300 });
    await context.close();
  });

  it('newPage() uses the same hardened context options', async () => {
    const page = await newPage(browser);
    await page.goto(base);
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#dl')]);
    expect(await download.failure()).toMatch(/acceptDownloads/);
    await page.close();
  });
});

describe('single launch site (issue #331)', () => {
  /** Every .ts file under src/, as [relative path, contents]. */
  function sources(dir = path.join(__dirname, '..', 'src')): Array<[string, string]> {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sources(full);
      if (!entry.name.endsWith('.ts')) return [];
      return [[path.relative(path.join(__dirname, '..'), full), fs.readFileSync(full, 'utf8')]];
    });
  }

  it('no module but src/browser.ts launches Chromium or opens a browser context', () => {
    // Structural, not name-based, so a renamed receiver cannot slip through:
    //  - a value import of a browser type (catches `chromium as pw` too);
    //  - any `.newContext(` at all;
    //  - `.newPage(` on anything but a `context` — the runners' contexts come
    //    from newHardenedContext(); `browser.newPage()` would make its own.
    const bypasses = [
      /import\s+(?!type\b)[^;]*\b(chromium|firefox|webkit)\b[^;]*from\s+['"]playwright/,
      /require\(\s*['"]playwright/,
      /\.newContext\(/,
      /(?<!\bcontext)\.newPage\(/,
    ];
    const offenders = sources()
      .filter(([file]) => file !== path.join('src', 'browser.ts'))
      .flatMap(([file, text]) =>
        text
          .split('\n')
          .map((line, i) => ({ line, at: `${file}:${i + 1}` }))
          .filter(({ line }) => !/^\s*(\/\/|\*)/.test(line) && bypasses.some((re) => re.test(line)))
          .map(({ at }) => at),
      );
    expect(offenders).toEqual([]);
  });
});
