/**
 * Hosted Chromium's traffic goes through the egress proxy (#336) — including
 * the requests the per-page CDP guard cannot see: dedicated and shared workers,
 * and WebSockets opened from them. WebRTC's non-proxied UDP is off.
 *
 * Test strategy: real Chromium through `launchBrowser()`, with IRIS_HOSTED=1
 * read inside `jest.isolateModules`. The shared proxy is started first with a
 * fake resolver and a dialer that serves the one "public" name, `site.test`,
 * from a local server — so the page itself loads *through* the proxy, and each
 * refusal has a matching allowed request from the same context that succeeds.
 * No URL guard is installed on the page: this isolates the proxy layer.
 *
 * The loopback server records every request and upgrade; a blocked target must
 * leave no record. Local mode runs the same probes as the negative control:
 * there the loopback server *is* reached, so the probes can see a leak.
 */

import * as dgram from 'dgram';
import { once } from 'events';
import * as http from 'http';
import * as net from 'net';
import { AddressInfo } from 'net';
import type { Browser, Page } from 'playwright';

type BrowserModule = typeof import('../src/browser');
type EgressModule = typeof import('../src/egress-proxy');
type HostedModule = typeof import('../src/hosted');

const PUBLIC = '8.8.8.8';

let server: http.Server;
let port: number;
let seen: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push(`GET ${req.url}`);
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>ok</title>');
  });
  server.on('upgrade', (req, socket) => {
    seen.push(`WS ${req.url}`);
    socket.destroy();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  port = (server.address() as AddressInfo).port;
});

afterAll(() => server.close());

beforeEach(() => {
  seen = [];
});

/** Launch through the real factory with IRIS_HOSTED set (or not) for a fresh registry. */
async function launch(hosted: boolean): Promise<Browser> {
  const prev = process.env.IRIS_HOSTED;
  if (hosted) process.env.IRIS_HOSTED = '1';
  else delete process.env.IRIS_HOSTED;
  try {
    let browserModule!: BrowserModule;
    let egress!: EgressModule;
    jest.isolateModules(() => {
      (require('../src/hosted') as HostedModule).isHostedMode();
      egress = require('../src/egress-proxy') as EgressModule;
      browserModule = require('../src/browser') as BrowserModule;
    });
    if (hosted) {
      await egress.hostedEgressProxy({
        lookup: async (host) => {
          if (host === 'site.test') return [PUBLIC];
          if (host === '127.0.0.1.nip.io') return ['127.0.0.1'];
          throw new Error(`ENOTFOUND ${host}`);
        },
        connect: (address, p) =>
          net.connect({ host: '127.0.0.1', port: address === PUBLIC ? port : p }),
      });
    }
    return await browserModule.launchBrowser();
  } finally {
    if (prev === undefined) delete process.env.IRIS_HOSTED;
    else process.env.IRIS_HOSTED = prev;
  }
}

/** Run `body` in a dedicated worker; resolves with whatever it posts. */
function inWorker(page: Page, body: string): Promise<string> {
  return page.evaluate(`new Promise((resolve) => {
    const w = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(body)}])));
    w.onmessage = (e) => resolve(e.data);
  })`);
}

/** Run `body` in a SharedWorker with `post` bound to its port. */
function inSharedWorker(page: Page, body: string): Promise<string> {
  const script = `onconnect = (e) => { const post = (m) => e.ports[0].postMessage(m); ${body} };`;
  return page.evaluate(`new Promise((resolve) => {
    const sw = new SharedWorker(URL.createObjectURL(new Blob([${JSON.stringify(script)}])));
    sw.port.onmessage = (e) => resolve(e.data);
    sw.port.start();
  })`);
}

const fetchThen = (url: string, post = 'postMessage'): string =>
  `fetch(${JSON.stringify(url)}).then(() => ${post}('ok'), () => ${post}('failed'));`;

const socketThen = (url: string): string =>
  `const s = new WebSocket(${JSON.stringify(url)});` +
  `s.onclose = () => postMessage('closed'); s.onerror = () => {};`;

describe('hosted Chromium egress (#336)', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await launch(true);
    page = await browser.newPage();
    // The document itself comes through the proxy: site.test -> 8.8.8.8 -> local server.
    await page.goto('http://site.test/');
  });

  afterAll(async () => {
    await browser?.close();
  });

  it('serves an allowed page, and allowed worker traffic, through the proxy (positive control)', async () => {
    expect(await page.title()).toBe('ok');
    expect(await inWorker(page, fetchThen('http://site.test/worker-ok'))).toBe('ok');
    expect(await inSharedWorker(page, fetchThen('http://site.test/shared-ok', 'post'))).toBe('ok');
    await inWorker(page, socketThen('ws://site.test/ws-ok'));
    expect(seen).toEqual(['GET /worker-ok', 'GET /shared-ok', 'WS /ws-ok']);
  });

  it('blocks a dedicated worker fetch to 127.0.0.1', async () => {
    await inWorker(page, fetchThen(`http://127.0.0.1:${port}/worker`));
    expect(seen).toEqual([]);
  });

  it('blocks a SharedWorker fetch to 127.0.0.1', async () => {
    await inSharedWorker(page, fetchThen(`http://127.0.0.1:${port}/shared`, 'post'));
    expect(seen).toEqual([]);
  });

  it('blocks a worker WebSocket to 127.0.0.1', async () => {
    expect(await inWorker(page, socketThen(`ws://127.0.0.1:${port}/ws`))).toBe('closed');
    expect(seen).toEqual([]);
  });

  it('blocks a name that resolves to loopback (127.0.0.1.nip.io)', async () => {
    await inWorker(page, fetchThen(`http://127.0.0.1.nip.io:${port}/nip`));
    expect(seen).toEqual([]);
  });
});

describe('local mode reaches loopback (negative control for the probes above)', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await launch(false);
    page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    seen = [];
  });

  afterAll(async () => {
    await browser?.close();
  });

  it('worker fetch, SharedWorker fetch and worker WebSocket all arrive', async () => {
    expect(await inWorker(page, fetchThen(`http://127.0.0.1:${port}/worker`))).toBe('ok');
    await inSharedWorker(page, fetchThen(`http://127.0.0.1:${port}/shared`, 'post'));
    await inWorker(page, socketThen(`ws://127.0.0.1:${port}/ws`));
    expect(seen).toEqual(['GET /worker', 'GET /shared', 'WS /ws']);
  });
});

describe('WebRTC in hosted mode (#336)', () => {
  /** STUN packets a page's ICE gathering sends to a local UDP socket. */
  async function stunPackets(hosted: boolean): Promise<number> {
    const udp = dgram.createSocket('udp4');
    let packets = 0;
    udp.on('message', () => packets++);
    udp.bind(0, '127.0.0.1');
    await once(udp, 'listening');
    const stun = `stun:127.0.0.1:${udp.address().port}`;
    const browser = await launch(hosted);
    try {
      const page = await browser.newPage();
      await page.goto(hosted ? 'http://site.test/' : `http://127.0.0.1:${port}/`);
      await page.evaluate(`(async () => {
        const pc = new RTCPeerConnection({ iceServers: [{ urls: ${JSON.stringify(stun)} }] });
        pc.createDataChannel('probe');
        await pc.setLocalDescription(await pc.createOffer());
        await new Promise((resolve) => {
          pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && resolve();
          setTimeout(resolve, 3000);
        });
      })()`);
      return packets;
    } finally {
      await browser.close();
      udp.close();
    }
  }

  it('negative control: local mode sends STUN over UDP', async () => {
    expect(await stunPackets(false)).toBeGreaterThan(0);
  });

  it('sends no non-proxied UDP', async () => {
    expect(await stunPackets(true)).toBe(0);
  });
});
