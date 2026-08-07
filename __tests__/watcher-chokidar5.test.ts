/**
 * Real chokidar 5 against a real directory (issue #172).
 *
 * The mocked tests in watcher.test.ts pin the shape of the call and the ignore
 * predicate. They cannot catch the failure that actually matters here: chokidar
 * 4 removed glob support, so passing `['**\/*.ts']` does not throw — it watches
 * a literal path of that name, finds nothing, and the watcher silently never
 * fires again. A mocked `watch()` happily accepts the glob and reports success.
 *
 * Only a real watcher on a real file proves the thing still works, so this file
 * deliberately does NOT mock chokidar.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileWatcher } from '../src/watcher';

const silent = { log: () => {}, warn: () => {}, error: () => {} };

/** Wait for `check` to hold, polling — file events are inherently async. */
async function until(check: () => boolean, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe('watcher against real chokidar 5 (issue #172)', () => {
  let dir: string;
  let watcher: FileWatcher | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-watch-'));
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
  });

  afterEach(async () => {
    await watcher?.stop().catch(() => {});
    watcher = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Start a watcher over the temp dir and collect the paths it reports. */
  const startWatching = async (patterns: string[]) => {
    const seen: string[] = [];
    watcher = new FileWatcher({
      patterns,
      ignore: ['node_modules/**'],
      cwd: dir,
      debounceMs: 30,
      persistent: true,
      logger: silent,
    });
    // The watcher runs an instruction on change; we only care which paths it
    // accepts, so intercept the handler rather than let it execute. Not called
    // through deliberately — the real one would translate an instruction and
    // drive a browser.
    type Handler = (type: string, filePath: string) => void;
    (watcher as unknown as { handleFileEvent: Handler }).handleFileEvent = (_type, filePath) => {
      seen.push(filePath);
    };
    await watcher.start();
    // start() resolves before chokidar's ready event, and `ignoreInitial: true`
    // swallows anything created during the initial scan — so a write issued too
    // early is silently dropped and every assertion below would fail for the
    // wrong reason. isRunning flips on ready.
    const ready = await until(() => watcher!.getStatus().isRunning, 10000);
    if (!ready) throw new Error('watcher never became ready');
    return seen;
  };

  it('still fires for a matching file — the failure mode a glob would cause silently', async () => {
    const seen = await startWatching(['**/*.{ts,tsx}']);

    fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export const a = 1;');

    expect(await until(() => seen.some((p) => p.endsWith('index.ts')))).toBe(true);
  }, 30000);

  it('does not fire for a file outside the patterns', async () => {
    const seen = await startWatching(['**/*.{ts,tsx}']);

    fs.writeFileSync(path.join(dir, 'src', 'notes.md'), '# hi');
    // Then a matching write, so we are waiting on a real signal rather than a
    // fixed sleep: if the .ts arrives and the .md never did, the filter works.
    fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export const a = 1;');

    expect(await until(() => seen.some((p) => p.endsWith('index.ts')))).toBe(true);
    expect(seen.some((p) => p.endsWith('notes.md'))).toBe(false);
  }, 30000);

  it('does not fire for ignored directories', async () => {
    const seen = await startWatching(['**/*.{ts,tsx}']);

    // A .ts file that matches the pattern but sits under an ignored directory.
    fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.ts'), 'x');
    fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export const a = 1;');

    expect(await until(() => seen.some((p) => p.endsWith(path.join('src', 'index.ts'))))).toBe(
      true,
    );
    expect(seen.some((p) => p.includes('node_modules'))).toBe(false);
  }, 30000);

  it('watches a single file target that lives outside the process cwd', async () => {
    // Caught in review of #182. chokidar 3 took the path as a watch target, so
    // cwd was irrelevant; chokidar 5 watches cwd and filters, so leaving cwd at
    // process.cwd() means a file elsewhere is never under the watched root and
    // `iris watch /elsewhere/page.html` silently watches nothing.
    //
    // Uses the real watchFiles path resolution rather than constructing the
    // watcher directly, because the bug lived in that resolution.
    const outside = path.join(dir, 'page.html');
    fs.writeFileSync(outside, '<html></html>');

    const seen: string[] = [];
    watcher = new FileWatcher({
      patterns: [outside],
      ignore: [],
      cwd: path.dirname(outside),
      debounceMs: 30,
      persistent: true,
      logger: silent,
    });
    type Handler = (type: string, filePath: string) => void;
    (watcher as unknown as { handleFileEvent: Handler }).handleFileEvent = (_t, p) => {
      seen.push(p);
    };
    await watcher.start();
    expect(await until(() => watcher!.getStatus().isRunning, 10000)).toBe(true);

    fs.writeFileSync(outside, '<html><body>changed</body></html>');

    expect(await until(() => seen.some((p) => p.endsWith('page.html')))).toBe(true);
  }, 30000);

  it('watches a RELATIVE file target that carries a directory component', async () => {
    // Caught in the second review pass of #182 — the gap my own fix opened.
    // `iris watch src/page.html` moves cwd to <root>/src, so chokidar reports
    // 'page.html', which never matches a pattern still reading 'src/page.html'.
    // The previous tests used a bare filename and an absolute path, so neither
    // exercised a relative target with a directory in it.
    const nestedDir = path.join(dir, 'src');
    const rel = path.join('src', 'page.html');
    fs.writeFileSync(path.join(nestedDir, 'page.html'), '<html></html>');

    const seen: string[] = [];
    // Mirrors what watchFiles now does for a relative file target.
    const resolved = path.resolve(dir, rel);
    watcher = new FileWatcher({
      patterns: [resolved],
      ignore: [],
      cwd: path.dirname(resolved),
      debounceMs: 30,
      persistent: true,
      logger: silent,
    });
    type Handler = (type: string, filePath: string) => void;
    (watcher as unknown as { handleFileEvent: Handler }).handleFileEvent = (_t, p) => {
      seen.push(p);
    };
    await watcher.start();
    expect(await until(() => watcher!.getStatus().isRunning, 10000)).toBe(true);

    fs.writeFileSync(path.join(nestedDir, 'page.html'), '<html><body>x</body></html>');

    expect(await until(() => seen.some((p) => p.endsWith('page.html')))).toBe(true);
  }, 30000);

  it('watches nested directories, proving the tree was not pruned', async () => {
    // The subtle prune bug: `src` matches no include pattern, so an ignore
    // filter that judged directories by the include patterns would stop
    // chokidar descending and nothing below would ever be seen.
    const nested = path.join(dir, 'src', 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });
    const seen = await startWatching(['**/*.ts']);

    fs.writeFileSync(path.join(nested, 'deep.ts'), 'export const d = 1;');

    expect(await until(() => seen.some((p) => p.endsWith('deep.ts')))).toBe(true);
  }, 30000);
});
