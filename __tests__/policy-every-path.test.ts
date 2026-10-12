/**
 * The agent policy on every execution path (issue #354).
 *
 * It used to run only in `iris run --agent`: one-shot `iris run` and the RPC executed a
 * model's plan with no policy, and `--allow*` were "--agent" flags. Now any plan a model
 * proposed gets the agent's defaults (origin pinned, destructive refused) and the flags;
 * a plan the caller wrote itself is restricted by `allow` only.
 *
 * A stand-in OpenAI always plans `click form button:nth-of-type(2)`. On the local site that
 * button is "Delete account", and clicking it POSTs /delete, which the site counts: the
 * count is what shows whether the click really happened. A beacon, not fetch: the CLI
 * exits right after the click, and closing the browser can abort a fetch in flight.
 */

import { spawn } from 'child_process';
import { createServer, Server } from 'http';
import { once } from 'events';
import type { AddressInfo } from 'net';
import * as path from 'path';
import WebSocket from 'ws';
import type { WebSocketServer } from 'ws';
import { planPolicy, startOriginOf } from '../src/agent-policy';
import { startServer } from '../src/protocol';

const REPO_ROOT = path.resolve(__dirname, '..');
const PAGE = `<!doctype html><html lang="en"><head><title>Account</title></head><body>
<form onsubmit="return false">
  <button type="button" onclick="navigator.sendBeacon('/save')">Save</button>
  <button type="button" onclick="navigator.sendBeacon('/delete')">Delete account</button>
</form></body></html>`;
const DESTRUCTIVE = [{ type: 'click', selector: 'form button:nth-of-type(2)' }];
/** What the stand-in model plans; a test may set it. */
let plannedActions: object[] = DESTRUCTIVE;

let site: Server;
let vendor: Server;
let siteUrl = '';
let vendorUrl = '';
let deletes = 0;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  site = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/delete') deletes++;
    res.setHeader('content-type', 'text/html');
    res.end(req.method === 'POST' ? 'ok' : PAGE);
  });
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
                content: JSON.stringify({ actions: plannedActions, confidence: 0.9 }),
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  siteUrl = `${await listen(site)}/`;
  vendorUrl = `${await listen(vendor)}/v1`;
});

afterAll(async () => {
  await new Promise((resolve) => site.close(resolve));
  await new Promise((resolve) => vendor.close(resolve));
});

beforeEach(() => {
  deletes = 0;
  plannedActions = DESTRUCTIVE;
});

/** Wait a beat for a click's fetch to reach the site. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 500));

describe('planPolicy and startOriginOf (#354)', () => {
  it("gives a model's plan the agent defaults, relaxed by the flags", () => {
    expect(planPolicy(true)).toEqual({
      allow: undefined,
      pinOrigin: true,
      allowDestructive: undefined,
    });
    expect(planPolicy(true, { allowCrossOrigin: true, allowDestructive: true })).toEqual({
      allow: undefined,
      pinOrigin: false,
      allowDestructive: true,
    });
  });

  it("gives the caller's own plan only a requested restriction", () => {
    expect(planPolicy(false)).toBeNull();
    expect(planPolicy(false, { allowDestructive: false })).toBeNull();
    expect(planPolicy(false, { allow: ['assert'] })).toEqual({
      allow: ['assert'],
      pinOrigin: false,
      allowDestructive: true,
    });
  });

  it('takes the start origin from the request, the page, then the first navigation', () => {
    const nav = [{ type: 'navigate' as const, url: 'https://b.test/x' }];
    expect(startOriginOf('https://a.test/p', 'https://c.test/', nav)).toBe('https://a.test');
    expect(startOriginOf(undefined, 'https://c.test/', nav)).toBe('https://c.test');
    expect(startOriginOf(undefined, 'about:blank', nav)).toBe('https://b.test');
    expect(startOriginOf(undefined, 'about:blank', [])).toBeNull();
  });
});

describe('one-shot iris run (#354)', () => {
  /** `url` null runs with no --url: the plan's own navigation, or nothing, is the start. */
  function irisRun(
    args: string[],
    url: string | null = siteUrl,
  ): Promise<{ status?: string; results: Array<{ success: boolean; error?: string }> }> {
    const proc = spawn(
      process.execPath,
      [
        '-r',
        'ts-node/register',
        path.join(REPO_ROOT, 'src/cli.ts'),
        'run',
        '--json',
        ...(url ? ['--url', url] : []),
        ...args,
      ],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          TS_NODE_TRANSPILE_ONLY: '1',
          OPENAI_API_KEY: 'sk-test',
          OPENAI_BASE_URL: vendorUrl,
        },
      },
    );
    let stdout = '';
    proc.stdout.on('data', (d) => (stdout += d));
    return new Promise((resolve, reject) =>
      proc.on('exit', () => {
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error(`no JSON on stdout: ${stdout}`));
        }
      }),
    );
  }
  const clickResult = (r: { results: Array<{ success: boolean; error?: string }> }) =>
    r.results[r.results.length - 1];

  it('refuses the destructive click an AI plan proposed, and it never reaches the site', async () => {
    const result = await irisRun(['tidy up my account']);
    await settled();
    expect(clickResult(result).error).toMatch(/Refused by agent policy.*looks destructive/);
    expect(deletes).toBe(0);
  }, 60_000);

  it('runs it with --allow-destructive', async () => {
    const result = await irisRun(['tidy up my account', '--allow-destructive']);
    await settled();
    expect(clickResult(result).success).toBe(true);
    expect(deletes).toBe(1);
  }, 60_000);

  it("runs the same click when the user typed it (a pattern plan is the user's own)", async () => {
    const result = await irisRun(['click form button:nth-of-type(2)']);
    await settled();
    expect(clickResult(result).success).toBe(true);
    expect(deletes).toBe(1);
  }, 60_000);

  // Codex review: a plan that starts by navigating reaches its start origin from a fresh page.
  it('runs an AI plan that starts by navigating, with no --url', async () => {
    plannedActions = [
      { type: 'navigate', url: siteUrl },
      { type: 'assert', kind: 'text_visible', target: 'Save' },
    ];
    const result = await irisRun(['open the account page'], null);
    expect(result.results.map((r) => r.success)).toEqual([true, true]);
  }, 60_000);

  // Codex review: the refusal used to return with the browser still open, so the CLI hung.
  it('refuses an AI plan with no origin to pin to, and exits', async () => {
    plannedActions = [{ type: 'click', selector: '#a' }];
    const result = await irisRun(['click something'], null);
    expect(result.status).toBe('error');
    expect(result.results).toEqual([]);
  }, 60_000);

  it('applies --allow to a pattern plan too', async () => {
    const result = await irisRun(['click form button:nth-of-type(2)', '--allow', 'assert']);
    await settled();
    expect(clickResult(result).error).toMatch(/Refused by agent policy.*not permitted/);
    expect(deletes).toBe(0);
  }, 60_000);
});

describe('RPC executeBrowserAction (#354)', () => {
  const TOKEN = 'policy-every-path-token';
  let wss: WebSocketServer;
  let url = '';

  beforeAll(async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.OPENAI_BASE_URL = vendorUrl;
    wss = startServer(0, { authToken: TOKEN });
    await once(wss, 'listening');
    url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    await new Promise((resolve) => wss.close(resolve));
  });

  /** A connection and a call helper; `close` ends it (wss.close waits for its clients). */
  async function session() {
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    await once(ws, 'open');
    let id = 0;
    const call = (method: string, params?: object): Promise<Record<string, any>> =>
      new Promise((resolve) => {
        const mine = ++id;
        const on = (d: WebSocket.Data) => {
          const reply = JSON.parse(String(d));
          if (reply.id === mine) {
            ws.off('message', on);
            resolve(reply);
          }
        };
        ws.on('message', on);
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: mine, method, params }));
      });
    return { call, close: () => ws.close() };
  }

  async function act(params: object) {
    const { call, close } = await session();
    try {
      await call('launchBrowser');
      await call('executeBrowserAction', { actions: [{ type: 'navigate', url: siteUrl }] });
      const reply = await call('executeBrowserAction', { url: siteUrl, ...params });
      await call('closeBrowser');
      await settled();
      return reply.result as { results: Array<{ success: boolean; error?: string }> };
    } finally {
      close();
    }
  }

  it('refuses the destructive click an AI-translated instruction proposed', async () => {
    const result = await act({ instruction: 'tidy up my account' });
    expect(result.results[0].error).toMatch(/Refused by agent policy.*looks destructive/);
    expect(deletes).toBe(0);
  }, 60_000);

  it('runs it with policy.allowDestructive', async () => {
    const result = await act({
      instruction: 'tidy up my account',
      policy: { allowDestructive: true },
    });
    expect(result.results[0].success).toBe(true);
    expect(deletes).toBe(1);
  }, 60_000);

  it("runs explicit actions as the client's own, restricted by policy.allow only", async () => {
    const click = { type: 'click', selector: 'form button:nth-of-type(2)' };
    expect((await act({ actions: [click] })).results[0].success).toBe(true);
    expect(deletes).toBe(1);
    const restricted = await act({ actions: [click], policy: { allow: ['assert'] } });
    expect(restricted.results[0].error).toMatch(/not permitted/);
    expect(deletes).toBe(1);
  }, 60_000);

  it('refuses an unknown policy field', async () => {
    const { call, close } = await session();
    try {
      const reply = await call('executeBrowserAction', {
        actions: [],
        policy: { pinOrigin: false },
      });
      expect(reply.error).toMatchObject({ code: -32602 });
    } finally {
      close();
    }
  });
});
