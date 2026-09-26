/**
 * The hosted egress proxy (#336): every connection Chromium makes in hosted mode
 * goes through it, and it refuses any target whose *resolved* address is private,
 * reserved or metadata — the gap string matching on a URL cannot close.
 *
 * Test strategy: real sockets end to end. DNS and dialing are the two seams:
 * `lookup` stands in for a resolver (so `127.0.0.1.nip.io` and a rebinding
 * resolver are hermetic), and `connect` redirects the one "public" address,
 * 8.8.8.8, to a local server — so the allowed path is proven to work, not just
 * the refusals. A proxy that refused everything would fail the positive controls.
 * The local server counts hits: a refusal must mean nothing reached it.
 */

import { once } from 'events';
import * as http from 'http';
import * as net from 'net';
import { AddressInfo } from 'net';
import { startEgressProxy, EgressProxy } from '../src/egress-proxy';

const PUBLIC = '8.8.8.8';

let target: http.Server;
let targetPort: number;
let hits: string[];

let proxy: EgressProxy;
let proxyPort: number;
let lookups: string[];
let dials: string[];
let answers: Record<string, string[][]>;
let slowLookup: Promise<void> = Promise.resolve();

beforeAll(async () => {
  target = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    res.end(`served ${req.url}`);
  });
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  targetPort = (target.address() as AddressInfo).port;
});

afterAll(async () => {
  target.close();
});

beforeEach(async () => {
  hits = [];
  lookups = [];
  dials = [];
  // Each name answers from a queue, so a rebinding resolver is a two-entry list.
  answers = {
    'site.test': [[PUBLIC]],
    '127.0.0.1.nip.io': [['127.0.0.1']],
    'mixed.test': [[PUBLIC, '10.0.0.1']],
    'rebind.test': [[PUBLIC], ['127.0.0.1']],
    // Public, dialed at 127.0.0.1 on the port asked for: a closed port, or a raw upstream.
    'down.test': [['8.8.4.4']],
    'slow.test': [['8.8.4.4']],
  };
  proxy = await startEgressProxy({
    lookup: async (host) => {
      lookups.push(host);
      if (host === 'slow.test') await slowLookup; // released by the test that uses it
      const queue = answers[host];
      if (!queue) throw new Error(`ENOTFOUND ${host}`);
      return queue.length > 1 ? queue.shift()! : queue[0];
    },
    connect: (address, port) => {
      dials.push(`${address}:${port}`);
      // The one public address is served locally; anything else would be a
      // real dial, which a refused target must never reach.
      return net.connect({ host: '127.0.0.1', port: address === PUBLIC ? targetPort : port });
    },
  });
  proxyPort = Number(new URL(proxy.url).port);
});

afterEach(async () => {
  await proxy.close();
});

/** Plain-HTTP proxy request (absolute-form), as Chromium sends for http:// URLs. */
function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, path: url, method: 'GET' });
    req.on('response', (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/** CONNECT through the proxy; on 200, send one HTTP request down the tunnel. */
function tunnel(authority: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: authority,
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        resolve({ status: res.statusCode ?? 0, body: '' });
        return;
      }
      let body = '';
      socket.on('data', (chunk) => (body += chunk));
      socket.on('end', () => resolve({ status: 200, body }));
      socket.write('GET /tunnelled HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    });
    req.on('error', reject);
    req.end();
  });
}

describe('egress proxy: allowed targets (positive controls)', () => {
  it('forwards a plain HTTP request to a public host, dialing the resolved address', async () => {
    const res = await get('http://site.test/page?q=1');
    expect(res).toEqual({ status: 200, body: 'served /page?q=1' });
    expect(dials).toEqual([`${PUBLIC}:80`]);
  });

  it('tunnels CONNECT to a public host', async () => {
    const res = await tunnel('site.test:443');
    expect(res.status).toBe(200);
    expect(res.body).toContain('served /tunnelled');
    expect(dials).toEqual([`${PUBLIC}:443`]);
  });
});

describe('egress proxy: refused targets', () => {
  it.each([
    ['IPv4 loopback literal', '127.0.0.1'],
    ['IPv6 loopback literal', '[::1]'],
    ['IPv4-mapped loopback', '[::ffff:127.0.0.1]'],
    ['cloud metadata', '169.254.169.254'],
    ['private network', '10.0.0.1'],
    ['a name that resolves to loopback (127.0.0.1.nip.io)', '127.0.0.1.nip.io'],
    ['a name with any private answer', 'mixed.test'],
  ])('refuses %s, over HTTP and CONNECT, before dialing', async (_label, host) => {
    const plain = await get(`http://${host}:${targetPort}/x`);
    const connect = await tunnel(`${host}:${targetPort}`);
    expect(plain.status).toBe(403);
    expect(connect.status).toBe(403);
    expect(dials).toEqual([]);
    expect(hits).toEqual([]);
  });

  it('refuses localhost through the real resolver', async () => {
    const real = await startEgressProxy();
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const port = Number(new URL(real.url).port);
        http
          .request({ host: '127.0.0.1', port, path: `http://localhost:${targetPort}/` })
          .on('response', (res) => resolve(res.statusCode ?? 0))
          .on('error', reject)
          .end();
      });
      expect(status).toBe(403);
      expect(hits).toEqual([]);
    } finally {
      await real.close();
    }
  });

  it('pins the vetted address: a rebinding resolver is looked up once per request and never dialed privately', async () => {
    // First answer public, second loopback — the classic rebinding flip. The
    // proxy resolves once per request and dials exactly what it vetted, so
    // there is no second lookup in which the answer can change.
    expect((await get('http://rebind.test/first')).status).toBe(200);
    expect((await get('http://rebind.test/second')).status).toBe(403);
    expect(lookups).toEqual(['rebind.test', 'rebind.test']);
    expect(dials).toEqual([`${PUBLIC}:80`]);
    expect(hits).toEqual(['/first']);
  });
});

describe('egress proxy: malformed and failing requests', () => {
  it('answers 502 when the name does not resolve', async () => {
    expect((await get('http://nowhere.test/')).status).toBe(502);
    expect((await tunnel('nowhere.test:443')).status).toBe(502);
  });

  it('answers 400 to a request that is not a proxy request', async () => {
    expect((await get('/origin-form')).status).toBe(400);
    expect(dials).toEqual([]);
  });

  it('answers 502 when the vetted address refuses the connection', async () => {
    // The dialer sends 8.8.4.4 to 127.0.0.1 on the requested port; port 1 is closed.
    expect((await get('http://down.test:1/')).status).toBe(502);
    expect((await tunnel('down.test:1')).status).toBe(502);
    expect(dials).toEqual(['8.8.4.4:1', '8.8.4.4:1']);
  });

  it('keeps serving after a client sends garbage', async () => {
    const sock = net.connect(proxyPort, '127.0.0.1');
    sock.on('error', () => {});
    sock.end('\x00\x01 not http\r\n\r\n');
    await once(sock, 'close');
    expect((await get('http://site.test/after')).status).toBe(200);
  });
});

/**
 * A hostile or broken public upstream, speaking raw bytes. Reached as
 * `down.test:<port>`; records whether each of its connections was closed.
 */
async function rawUpstream(
  onConnection: (socket: net.Socket) => void,
): Promise<{ port: number; closed: Promise<void>; stop: () => void }> {
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => (markClosed = resolve));
  const raw = net.createServer((socket) => {
    socket.on('error', () => {});
    // Read (and drop) the request, or a paused socket never sees the FIN.
    socket.resume();
    socket.once('close', markClosed);
    onConnection(socket);
  });
  raw.listen(0, '127.0.0.1');
  await once(raw, 'listening');
  return {
    port: (raw.address() as AddressInfo).port,
    closed,
    stop: () => raw.close(),
  };
}

/** Resolves 'closed' if `closed` settles within the window, else 'open'. */
function within(closed: Promise<void>, ms = 2000): Promise<'closed' | 'open'> {
  return Promise.race([
    closed.then(() => 'closed' as const),
    new Promise<'open'>((resolve) => setTimeout(() => resolve('open'), ms)),
  ]);
}

describe('egress proxy: hostile or broken upstreams', () => {
  it.each([
    ['a status writeHead rejects (099)', 'HTTP/1.1 099 X\r\ncontent-length: 0\r\n\r\n'],
    ['a status writeHead rejects (000)', 'HTTP/1.1 000 X\r\ncontent-length: 0\r\n\r\n'],
    [
      'an unrequested protocol switch',
      'HTTP/1.1 101 Switching\r\nupgrade: x\r\nconnection: upgrade\r\n\r\n',
    ],
  ])('answers 502 to %s and keeps serving', async (_label, reply) => {
    // Node's client parser accepts these, and a throw in the response listener
    // would be an uncaught exception, which ends `iris connect`.
    const up = await rawUpstream((socket) => socket.write(reply));
    try {
      expect((await get(`http://down.test:${up.port}/`)).status).toBe(502);
      expect((await get('http://site.test/after')).status).toBe(200);
    } finally {
      up.stop();
    }
  });

  it('ends the client response when the upstream dies mid-body, rather than hanging', async () => {
    const up = await rawUpstream((socket) =>
      socket.end('HTTP/1.1 200 OK\r\ncontent-length: 100\r\n\r\n0123456789'),
    );
    try {
      await expect(get(`http://down.test:${up.port}/`)).rejects.toThrow();
    } finally {
      up.stop();
    }
  });

  it('survives an upstream that resets the connection mid-body', async () => {
    // A reset (RST), unlike a clean FIN, surfaces as an 'error' on the upstream
    // response. Unhandled, that is an uncaught exception, which ends `iris connect`.
    const up = await rawUpstream((socket) => {
      socket.write('HTTP/1.1 200 OK\r\ncontent-length: 100\r\n\r\n0123456789', () =>
        setTimeout(() => socket.resetAndDestroy(), 50),
      );
    });
    try {
      await expect(get(`http://down.test:${up.port}/`)).rejects.toThrow();
      expect((await get('http://site.test/after')).status).toBe(200);
    } finally {
      up.stop();
    }
  });

  it('closes the upstream connection once the response is done', async () => {
    // A keep-alive upstream socket nobody reuses is a descriptor leaked per request.
    const up = await rawUpstream((socket) =>
      socket.write('HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: keep-alive\r\n\r\nok'),
    );
    try {
      expect(await get(`http://down.test:${up.port}/`)).toEqual({ status: 200, body: 'ok' });
      expect(await within(up.closed)).toBe('closed');
    } finally {
      up.stop();
    }
  });

  it('closes the upstream connection when the client goes away mid-response', async () => {
    const up = await rawUpstream((socket) =>
      socket.write('HTTP/1.1 200 OK\r\ncontent-length: 1000000\r\n\r\npartial'),
    );
    try {
      await new Promise<void>((resolve) => {
        const req = http.request({
          host: '127.0.0.1',
          port: proxyPort,
          path: `http://down.test:${up.port}/`,
        });
        req.on('response', () => {
          req.destroy();
          resolve();
        });
        req.on('error', () => {});
        req.end();
      });
      expect(await within(up.closed)).toBe('closed');
    } finally {
      up.stop();
    }
  });

  it('does not leak the upstream when a CONNECT client leaves during the lookup', async () => {
    // A cancelled preconnect: the client is gone before the name resolves.
    const up = await rawUpstream(() => {});
    let release!: () => void;
    slowLookup = new Promise<void>((resolve) => (release = resolve));
    try {
      const client = net.connect(proxyPort, '127.0.0.1');
      client.on('error', () => {});
      await once(client, 'connect');
      client.write(`CONNECT slow.test:${up.port} HTTP/1.1\r\nHost: slow.test\r\n\r\n`);
      while (!lookups.includes('slow.test')) await new Promise((r) => setImmediate(r));
      client.destroy();
      await once(client, 'close');
      release();
      // Dialed or not, nothing may be left holding an upstream socket.
      const dialed = await within(
        new Promise<void>((resolve) => setTimeout(resolve, 200)).then(() =>
          dials.length === 0 ? undefined : up.closed,
        ),
      );
      expect(dialed).toBe('closed');
    } finally {
      up.stop();
    }
  });
});
