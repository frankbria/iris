import WebSocket from 'ws';
import http from 'http';
import fs from 'fs';
import { AddressInfo } from 'net';
import { startServer, JsonRpcResponse } from '../src/protocol';
import * as browserModule from '../src/browser';

/**
 * Browser session lifecycle (#240), over a real socket with a real Chromium.
 *
 * "Is the browser gone?" is answered by counting this process's Chromium
 * children in /proc, not by trusting a flag the code under test sets itself.
 * Linux-only, like browser-hardening.test.ts.
 */

type Server = ReturnType<typeof startServer>;
const servers: Server[] = [];
const sockets: WebSocket[] = [];

/** Direct children of this process that are a Chromium browser (not a helper). */
function chromiumChildren(): number[] {
  const pids: number[] = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
      // comm may contain spaces or parens; state and ppid follow the last ')'.
      const [state, ppid] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(ppid) !== process.pid || state === 'Z') continue;
      if (/chrom/i.test(fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8'))) pids.push(+entry);
    } catch {
      // Exited between readdir and read.
    }
  }
  return pids;
}

/** Poll until `check` holds. Attempts, not elapsed-time assertions (#190). */
async function eventually(check: () => boolean | Promise<boolean>, attempts = 250) {
  for (let i = 0; i < attempts; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('condition never held');
}

/**
 * Wait for every Chromium child to exit. Generous on purpose: a plain close()
 * measured 1.4-1.9s on a loaded host and up to 9s end to end, while an orphan
 * never exits at all, so a long budget costs no signal.
 */
const exited = () => eventually(() => chromiumChildren().length === 0, 1500);

async function serve(options: Parameters<typeof startServer>[1] = {}): Promise<string> {
  const wss = startServer(0, options);
  servers.push(wss);
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  return `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
}

function open(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    sockets.push(ws);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

let nextId = 1;
function send(ws: WebSocket, method: string, params?: unknown): number {
  const id = nextId++;
  ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  return id;
}

function call(ws: WebSocket, method: string, params?: unknown): Promise<JsonRpcResponse> {
  return new Promise((resolve, reject) => {
    const onClose = () => reject(new Error('socket closed'));
    const onMessage = (data: WebSocket.Data) => {
      const res = JSON.parse(data.toString()) as JsonRpcResponse;
      if (res.id !== id) return;
      ws.off('message', onMessage).off('close', onClose);
      resolve(res);
    };
    ws.on('message', onMessage).on('close', onClose);
    const id = send(ws, method, params);
  });
}

/** A loopback page. While `hold` is set, requests wait for it before answering. */
let hold: Promise<void> | null = null;
let arrived: (() => void) | null = null;
let pageUrl: string;
let site: http.Server;

beforeAll(async () => {
  site = http.createServer(async (_req, res) => {
    const held = hold;
    if (held) {
      arrived?.();
      await held;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>t</title><h1>hi</h1>');
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  pageUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  await new Promise((r) => site.close(r));
});

afterEach(async () => {
  jest.restoreAllMocks();
  for (const ws of sockets.splice(0)) ws.terminate();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
  await exited();
}, 60000);

const navigate = () => ({ actions: [{ type: 'navigate', url: pageUrl }] });

describe('disconnect during launch', () => {
  // The Chromium is already up when the socket goes, and the page it was for
  // then fails. Cleanup ran while the executor still had no browser, and the
  // failed page creation skipped the protocol's own after-the-fact check, so
  // nothing ever closed it.
  test('closes the browser even when page creation then fails', async () => {
    const realLaunch = browserModule.launchBrowser;
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let launched!: () => void;
    const launchedP = new Promise<void>((r) => (launched = r));
    jest.spyOn(browserModule, 'launchBrowser').mockImplementation(async (opts) => {
      const browser = await realLaunch(opts);
      launched();
      await released;
      return browser;
    });
    jest.spyOn(browserModule, 'newPage').mockRejectedValue(new Error('page failed'));

    const url = await serve();
    const ws = await open(url);
    await call(ws, 'launchBrowser');
    send(ws, 'executeBrowserAction', navigate());

    await launchedP;
    expect(chromiumChildren()).toHaveLength(1);
    ws.close();
    await eventually(() => servers[0].clients.size === 0);
    release();

    await exited();
  }, 60000);
});

describe('browser crash', () => {
  test('the next request relaunches instead of reusing the dead browser', async () => {
    const url = await serve();
    const ws = await open(url);
    await call(ws, 'launchBrowser');
    expect((await call(ws, 'executeBrowserAction', navigate())).result.success).toBe(true);

    const [pid] = chromiumChildren();
    expect(pid).toBeDefined();
    process.kill(pid, 'SIGKILL');
    // Playwright notices a little after the process is gone; a request in
    // that window gets a "browser has been closed" error, which is clear enough.
    await eventually(async () => !(await call(ws, 'getBrowserStatus')).result.hasPage);

    const after = await call(ws, 'executeBrowserAction', navigate());
    expect(after.result.success).toBe(true);
    expect(chromiumChildren()).toHaveLength(1);
    expect(chromiumChildren()).not.toContain(pid);
  }, 60000);
});

describe('inactivity sweep', () => {
  const sessionTimeout = 100;

  test('never closes a session whose request is still running', async () => {
    const url = await serve({ sessionTimeout });
    const ws = await open(url);
    await call(ws, 'launchBrowser');

    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    const arrival = new Promise<void>((r) => (arrived = r));
    try {
      const pending = call(ws, 'executeBrowserAction', navigate());
      await arrival;
      // Several sweep periods pass while the navigation is held open.
      await new Promise((r) => setTimeout(r, sessionTimeout * 6));
      hold = null;
      release();
      expect((await pending).result.success).toBe(true);
    } finally {
      hold = null;
      arrived = null;
      release();
    }
    // Still the same live session: no relaunch was needed.
    expect((await call(ws, 'getStatus')).result.hasSession).toBe(true);
  }, 60000);

  test('still reclaims a session once it is idle', async () => {
    const url = await serve({ sessionTimeout });
    const ws = await open(url);
    await call(ws, 'launchBrowser');
    expect((await call(ws, 'executeBrowserAction', navigate())).result.success).toBe(true);

    await eventually(async () => !(await call(ws, 'getStatus')).result.hasSession);
    await exited();
  }, 60000);
});
