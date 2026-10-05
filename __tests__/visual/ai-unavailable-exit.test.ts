/**
 * #281: a failed AI analysis must not grade a regression down to a pass.
 *
 * The real chain: `iris visual-diff --semantic` through runCli, real Chromium, real
 * capture and diff, the real AIVisualClassifier and CostTracker. A $0 daily budget
 * trips the breaker before any provider call ("free providers only"), so no request
 * leaves the machine. Only the git-backed baseline store is held in memory: the test
 * must not write baselines into this repository's git history.
 */
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

const baselines = new Map<string, Buffer>();
jest.mock('../../src/visual/baseline', () => ({
  BaselineManager: jest.fn().mockImplementation(() => ({
    resolveReference: async () => 'main',
    loadBaseline: async (names: string | string[]) => {
      const buffer = baselines.get([names].flat()[0]);
      return buffer ? { success: true, buffer } : { success: false, error: 'none' };
    },
    saveBaseline: async (name: string, buffer: Buffer) => {
      baselines.set(name, buffer);
      return { success: true };
    },
  })),
}));

describe('visual-diff when AI analysis is unavailable (#281)', () => {
  let colour = 'rgb(30, 60, 200)';
  const site = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><body style="margin:0;background:${colour}"><h1>Shop</h1></body>`);
  });
  const cwd = process.cwd();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-281-'));
  const saved = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    IRIS_DAILY_BUDGET_USD: process.env.IRIS_DAILY_BUDGET_USD,
  };
  let base = '';

  beforeAll(async () => {
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    // Run artifacts and the report land in the working directory (.iris/runs/...).
    process.chdir(work);
    process.env.OPENAI_API_KEY = 'sk-test-281-not-a-real-key';
    process.env.IRIS_DAILY_BUDGET_USD = '0';
  });

  afterAll(async () => {
    process.chdir(cwd);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await new Promise((resolve) => site.close(resolve));
    fs.rmSync(work, { recursive: true, force: true });
  });

  async function visualDiff(args: string[]): Promise<{ code: number | undefined; out: string }> {
    const logs: string[] = [];
    const log = jest
      .spyOn(console, 'log')
      .mockImplementation((...a) => void logs.push(a.join(' ')));
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    let code: number | undefined;
    const exit = jest.spyOn(process, 'exit').mockImplementation(((c?: number) => {
      // The first exit is the verdict: the spy's throw lands in the CLI's catch, which exits 3.
      code ??= c;
      throw new Error('process.exit');
    }) as never);
    try {
      jest.resetModules();
      const { runCli } = await import('../../src/cli');
      await runCli([
        'node',
        'iris',
        'visual-diff',
        '--base-url',
        base,
        '--format',
        'json',
        ...args,
      ]);
    } catch (e) {
      if ((e as Error).message !== 'process.exit') throw e;
    } finally {
      exit.mockRestore();
      log.mockRestore();
      err.mockRestore();
      warn.mockRestore();
    }
    return { code, out: logs.join('\n') };
  }

  it('grades a large change by its pixels and exits 5 under --fail-on breaking', async () => {
    // First run: no baseline, so this screenshot becomes it.
    expect((await visualDiff(['--pages', '/'])).code).toBeUndefined();
    expect(baselines.size).toBe(1);

    // The whole background changes colour: far past the 15% "breaking" line.
    colour = 'rgb(220, 30, 30)';
    const run = await visualDiff(['--pages', '/', '--semantic', '--fail-on', 'breaking']);

    expect(run.out).toMatch(/Breaking: 1/);
    expect(run.out).toMatch(/AI: unavailable for 1 comparison/);
    expect(run.code).toBe(5);
  }, 60_000);
});
