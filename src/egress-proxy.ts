/**
 * The hosted browser's network egress layer (#336, ADR 0001 §5).
 *
 * The URL policy judges a URL by its spelling, so a name that *resolves* to a
 * private address (`127.0.0.1.nip.io`, DNS rebinding) passes it, and the CDP
 * guard never sees worker requests at all. This proxy sits under every
 * connection hosted Chromium makes — page, worker, SharedWorker, WebSocket —
 * resolves the target itself, refuses it if any address is private, reserved or
 * metadata, and dials the address it vetted. One lookup per connection, and the
 * dial uses its answer, so there is no second lookup for a rebinding resolver
 * to change.
 *
 * Speaks plain HTTP (absolute-form requests) and CONNECT, which is what Chromium
 * sends for http://, https:// and ws(s):// through an HTTP proxy.
 */

import { once } from 'events';
import * as dns from 'dns';
import * as http from 'http';
import * as net from 'net';
import type { Duplex } from 'stream';
import { isBlockedAddress } from './url-policy';

export interface EgressProxyOptions {
  /** Every address a hostname resolves to. Default: the system resolver. */
  lookup?: (hostname: string) => Promise<string[]>;
  /** Open the upstream connection to an already-vetted address. Default: `net.connect`. */
  connect?: (address: string, port: number) => net.Socket;
}

export interface EgressProxy {
  /** `http://127.0.0.1:<port>`, for Chromium's `--proxy-server`. */
  url: string;
  close(): Promise<void>;
}

/** Request headers that describe the client's hop, not the upstream's. */
const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'te',
  'trailer',
  'upgrade',
];

/** Why a request was not forwarded, as the HTTP status the client gets. */
class Refusal extends Error {
  constructor(
    readonly status: 400 | 403 | 502,
    message: string,
  ) {
    super(message);
  }
}

async function systemLookup(hostname: string): Promise<string[]> {
  return (await dns.promises.lookup(hostname, { all: true })).map((a) => a.address);
}

function statusOf(error: unknown): { status: number; message: string } {
  return error instanceof Refusal
    ? { status: error.status, message: error.message }
    : { status: 502, message: 'upstream connection failed' };
}

/** `host:port` of a CONNECT request. The port is mandatory there. */
function parseAuthority(raw: string): { hostname: string; port: number } {
  let url: URL | undefined;
  try {
    url = new URL(`http://${raw}`);
  } catch {
    // fall through
  }
  if (!url || url.pathname !== '/' || !/:\d+$/.test(raw)) {
    throw new Refusal(400, 'malformed CONNECT authority');
  }
  // `URL` drops a port equal to http's default, which is still the port asked for.
  return { hostname: url.hostname, port: Number(url.port || 80) };
}

/**
 * Start a proxy on an ephemeral loopback port. It does not keep the process
 * alive on its own.
 */
export async function startEgressProxy(options: EgressProxyOptions = {}): Promise<EgressProxy> {
  const lookup = options.lookup ?? systemLookup;
  const connect = options.connect ?? ((address, port) => net.connect({ host: address, port }));

  /** The one address this connection may use: resolved once, vetted, dialed as-is. */
  async function vet(hostname: string): Promise<string> {
    const host = hostname.replace(/^\[|\]$/g, '');
    let addresses: string[];
    try {
      addresses = net.isIP(host) ? [host] : await lookup(host);
    } catch {
      addresses = [];
    }
    if (addresses.length === 0) throw new Refusal(502, `cannot resolve ${host}`);
    // Any private answer refuses the name: mixing one into a public set is how
    // a resolver would steer a connection inward. The address itself is not
    // echoed, so a page cannot use this to map internal DNS.
    if (addresses.some(isBlockedAddress)) {
      throw new Refusal(403, `${host} resolves to a private or reserved address`);
    }
    return addresses[0];
  }

  async function forward(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      throw new Refusal(400, 'not a proxy request');
    }
    if (url.protocol !== 'http:') throw new Refusal(400, `unsupported scheme ${url.protocol}`);

    const address = await vet(url.hostname);
    if (req.socket.destroyed) return; // the client left while the name resolved
    const port = Number(url.port || 80);
    const headers = { ...req.headers };
    for (const name of HOP_BY_HOP) delete headers[name];
    // One request per upstream socket: nothing pools them, so a kept-alive one
    // would be a descriptor leaked per request.
    headers.connection = 'close';

    const upstream = http.request({
      method: req.method,
      path: url.pathname + url.search,
      headers,
      setHost: false, // the client's Host header is already the right one
      createConnection: () => connect(address, port),
    });
    // Fires when the response is done or the client went away mid-way; either
    // way the upstream has nothing left to do.
    res.on('close', () => upstream.destroy());
    upstream.on('response', (upstreamRes) => {
      // Node's parser accepts statuses `writeHead` rejects (000, 099). A throw
      // here would be uncaught and end `iris connect`.
      try {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      } catch {
        refuse(res, new Refusal(502, 'invalid upstream status'));
        return;
      }
      // An upstream that dies mid-body never ends `res` through the pipe.
      upstreamRes.on('close', () => upstreamRes.complete || res.destroy());
      upstreamRes.pipe(res);
    });
    upstream.on('upgrade', (_upstreamRes, socket) => {
      socket.destroy();
      refuse(res, new Refusal(502, 'upstream switched protocols unasked'));
    });
    upstream.on('error', (error) => refuse(res, error));
    req.on('error', () => upstream.destroy());
    req.pipe(upstream);
  }

  function refuse(res: http.ServerResponse, error: unknown): void {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const { status, message } = statusOf(error);
    res.writeHead(status, { 'content-type': 'text/plain', connection: 'close' });
    res.end(`IRIS egress proxy: ${message}`);
  }

  async function tunnel(req: http.IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    const { hostname, port } = parseAuthority(req.url ?? '');
    const address = await vet(hostname);
    const upstream = connect(address, port);
    let established = false;
    client.on('close', () => upstream.destroy());
    upstream.on('error', (error) => {
      if (!established) refuseTunnel(client, error);
      client.destroy();
    });
    upstream.once('connect', () => {
      established = true;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
  }

  function refuseTunnel(client: Duplex, error: unknown): void {
    const { status, message } = statusOf(error);
    const body = `IRIS egress proxy: ${message}`;
    client.end(
      `HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\n` +
        `content-type: text/plain\r\ncontent-length: ${Buffer.byteLength(body)}\r\n` +
        `connection: close\r\n\r\n${body}`,
    );
  }

  const server = http.createServer((req, res) => {
    forward(req, res).catch((error) => refuse(res, error));
  });
  server.on('connect', (req: http.IncomingMessage, client: Duplex, head: Buffer) => {
    // A socket error with no listener is an uncaught exception, which ends
    // `iris connect` (#330). Every socket here gets one.
    client.on('error', () => client.destroy());
    tunnel(req, client, head).catch((error) => refuseTunnel(client, error));
  });
  server.on('clientError', (_error, socket) => socket.destroy());

  // Tracked so close() also ends CONNECT tunnels, which the server stops
  // counting once they are handed over.
  const sockets = new Set<net.Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  server.unref();

  return {
    url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

let shared: Promise<EgressProxy> | undefined;

/**
 * The process's one egress proxy, started on first use by {@link launchBrowser}
 * in hosted mode. `options` apply only to the call that starts it — tests use
 * them to substitute DNS and dialing before the first launch.
 */
export function hostedEgressProxy(options?: EgressProxyOptions): Promise<EgressProxy> {
  shared ??= startEgressProxy(options).catch((error: unknown) => {
    shared = undefined; // a failed start must not poison every later launch
    throw error;
  });
  return shared;
}
