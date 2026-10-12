/**
 * Every `iris run "…"` example in the README, checked (issue #297).
 *
 * An example the pattern path translates runs in real Chromium against a local page
 * that has the elements it names, with `https://example.com` swapped for that page.
 * An example written in prose must reach the AI path; with no AI configured (the
 * suite's environment) it must say so and say what to write instead.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { createServer, Server } from 'http';
import type { AddressInfo } from 'net';
import { chromium, Browser } from 'playwright';
import { translate, translateSync } from '../src/translator';
import { ActionExecutor } from '../src/executor';
import { mapSecrets } from '../src/credential-refs';

const FIXTURE = `<!doctype html><title>fixture</title>
<input id="email"><input id="password" type="password">
<button id="submit-button" onclick="document.title='clicked'">Go</button>`;

function readmeRunExamples(): string[] {
  const readme = readFileSync(join(__dirname, '..', 'README.md'), 'utf8');
  return readme
    .split('\n')
    .filter((line) => /\biris run\b/.test(line) && !line.includes('--agent'))
    .map((line) => /"([^"]+)"/.exec(line)?.[1])
    .filter((instruction): instruction is string => instruction !== undefined);
}

const examples = readmeRunExamples();
const patternExamples = examples.filter((i) => translateSync(i).length > 0);
const proseExamples = examples.filter((i) => translateSync(i).length === 0);

describe('README `iris run` examples (issue #297)', () => {
  it('finds both kinds of example in the README', () => {
    expect(patternExamples.length).toBeGreaterThanOrEqual(4);
    expect(proseExamples.length).toBeGreaterThanOrEqual(2);
  });

  describe('pattern examples run against a real page', () => {
    let server: Server;
    let browser: Browser;
    let base: string;

    beforeAll(async () => {
      server = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(FIXTURE);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
      browser = await chromium.launch();
    });

    afterAll(async () => {
      await browser?.close();
      await new Promise((resolve) => server?.close(resolve));
    });

    it.each(patternExamples)('%s', async (example) => {
      const actions = translateSync(example.replace('https://example.com', base));
      const page = await browser.newPage();
      try {
        await page.goto(base);
        const executor = new ActionExecutor({ timeout: 2000, retryAttempts: 0 });
        const results = await executor.executeActions(
          actions,
          page,
          mapSecrets({ LOGIN_PW: 'pw-for-tests' }),
        );
        expect(results.map((r) => r.error ?? 'ok')).toEqual(actions.map(() => 'ok'));
        if (actions.some((a) => a.type === 'click')) expect(await page.title()).toBe('clicked');
      } finally {
        await page.close();
      }
    });
  });

  describe('prose examples go to the AI, and say so without one', () => {
    it.each(proseExamples)('%s', async (example) => {
      const result = await translate(example);
      expect(result.method).toBe('ai');
      expect(result.actions).toEqual([]);
      expect(result.reasoning).toMatch(/no pattern matched/i);
      expect(result.reasoning).toMatch(/click #submit/);
    });
  });
});
