/**
 * `iris watch --execute --url` pins an AI plan to the URL's origin at the request layer
 * (#319, codex review): the per-action check sees an off-origin request only after a click
 * has sent it.
 *
 * Test strategy: real Chromium through the watcher's own executor, a stand-in OpenAI vendor
 * (OPENAI_BASE_URL) that plans one click, and two local servers on different origins
 * (127.0.0.1 and localhost). The button is benign ("Save"), so only the origin pin can stop
 * its form from posting to the other origin; that server counts what reaches it.
 */

import { once } from 'events';
import * as fs from 'fs';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { FileWatcher } from '../src/watcher';

let site: Server;
let offsite: Server;
let vendor: Server;
let posted = 0;
let siteUrl = '';

const listen = async (server: Server) => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
};

beforeAll(async () => {
  offsite = createServer((req, res) => {
    if (req.method === 'POST') posted++;
    res.end('collected');
  });
  const offsitePort = await listen(offsite);
  site = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(
      `<!doctype html><title>Form</title><form method="post" action="http://localhost:${offsitePort}/collect"><button>Save</button></form>`,
    );
  });
  siteUrl = `http://127.0.0.1:${await listen(site)}/`;
  vendor = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  actions: [{ type: 'click', selector: 'button' }],
                  confidence: 0.9,
                }),
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${await listen(vendor)}/v1`;
});

afterAll(async () => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  for (const server of [site, offsite, vendor]) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

it("keeps an AI plan's click from posting to another origin", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-watch-pin-'));
  const silent = { log: () => {}, warn: () => {}, error: () => {} };
  const watcher = new FileWatcher({
    execute: true,
    url: siteUrl,
    cwd,
    instruction: 'save the form',
    debounceMs: 20,
    persistent: false,
    logger: silent,
    browserTimeout: 5_000,
  });
  try {
    // The run itself, not chokidar's timing: one change to a source file.
    type Run = (e: { type: 'change'; path: string; timestamp: Date }) => Promise<void>;
    await (watcher as unknown as { executeInstruction: Run }).executeInstruction({
      type: 'change',
      path: 'src/app.ts',
      timestamp: new Date(),
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(posted).toBe(0);
  } finally {
    await watcher.stop();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}, 90_000);
