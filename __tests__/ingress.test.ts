/**
 * The TLS ingress (#347): deploy/nginx/iris.conf, run by a real nginx.
 *
 * Test strategy: the committed template is rendered with test values only (free
 * ports for 80/443, in-test upstreams in place of iris-api and the portal, a
 * self-signed certificate) and served by the pinned nginx image on the host network.
 * Everything else is the file as an operator installs it. The upstreams record what
 * reached them, so "nginx refused it" and "the upstream never saw it" are both
 * checked, not inferred from a status code.
 *
 * Docker is required under CI and skipped (with a warning) locally without it.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as tls from 'tls';
import WebSocket, { WebSocketServer } from 'ws';

const IMAGE = 'nginx:1.29-alpine';
const HOST = 'iris.example.com';
const TEMPLATE = path.resolve(__dirname, '..', 'deploy', 'nginx', 'iris.conf');

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const DOCKER = dockerAvailable();
if (!DOCKER) {
  if (process.env.CI) throw new Error('Docker is required in CI for the ingress test');
  console.warn('Skipping ingress tests: Docker is not available');
}

interface Seen {
  path: string;
  headers: http.IncomingHttpHeaders;
}

/** An upstream that answers 200 with its name and records every request. */
async function upstream(name: string) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    seen.push({ path: req.url!, headers: req.headers });
    res.end(name);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, seen, port: (server.address() as net.AddressInfo).port };
}

/** A port nothing listens on right now, on both families (nginx binds 0.0.0.0 and [::]). */
async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((resolve) => s.listen(0, '::', resolve));
  const { port } = s.address() as net.AddressInfo;
  await new Promise((resolve) => s.close(resolve));
  return port;
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

(DOCKER ? describe : describe.skip)('TLS ingress (deploy/nginx/iris.conf)', () => {
  const name = `iris-ingress-test-${process.pid}`;
  let dir: string;
  let cert: Buffer;
  let httpPort: number;
  let httpsPort: number;
  let api: Awaited<ReturnType<typeof upstream>>;
  let portal: Awaited<ReturnType<typeof upstream>>;
  let wss: WebSocketServer;

  /** One https request to nginx, from `local` (127.0.0.1 or ::1), trusting only the test CA. */
  function get(
    urlPath: string,
    headers: http.OutgoingHttpHeaders = {},
    local = '127.0.0.1',
  ): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: local,
          port: httpsPort,
          path: urlPath,
          headers: { host: HOST, ...headers },
          ca: cert,
          servername: HOST,
          agent: false,
        },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-ingress-'));
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', `/CN=${HOST}`, '-addext', `subjectAltName=DNS:${HOST}`,
        '-keyout', path.join(dir, 'privkey.pem'), '-out', path.join(dir, 'fullchain.pem'),
      ],
      { stdio: 'ignore' },
    ); // prettier-ignore
    // nginx's master reads them as root; the dir is mkdtemp's 0700.
    fs.chmodSync(dir, 0o755);
    cert = fs.readFileSync(path.join(dir, 'fullchain.pem'));

    api = await upstream('api');
    // The RPC server shares its HTTP listener with ws, as `startServer` does.
    wss = new WebSocketServer({ server: api.server });
    wss.on('connection', (ws, req) => {
      api.seen.push({ path: req.url!, headers: req.headers });
      ws.on('message', (m) => ws.send(`echo:${m}`));
    });
    portal = await upstream('portal');
    httpPort = await freePort();
    httpsPort = await freePort();

    // Only ports and upstreams change; the certificate paths are the template's own.
    const conf = fs
      .readFileSync(TEMPLATE, 'utf8')
      .replace(/listen (\[::\]:)?80;/g, `listen $1${httpPort};`)
      .replace(/listen (\[::\]:)?443 ssl;/g, `listen $1${httpsPort} ssl;`)
      .replace(/127\.0\.0\.1:4000/g, `127.0.0.1:${api.port}`)
      .replace(/127\.0\.0\.1:3000/g, `127.0.0.1:${portal.port}`)
      // Test-only: a request from ::1 may name its client address in X-Test-Client
      // (nginx's realip module), so the shipped zones can be fed IPv6 addresses this
      // host does not have. Requests without the header keep their real peer.
      .replace(
        /^(\s*)ssl_session_cache .*$/m,
        '$&\n$1set_real_ip_from ::1;\n$1real_ip_header X-Test-Client;',
      );
    expect(conf).toContain('real_ip_header X-Test-Client;');
    fs.writeFileSync(path.join(dir, 'iris.conf'), conf);
    fs.chmodSync(path.join(dir, 'iris.conf'), 0o644);

    execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    execFileSync('docker', [
      'run', '-d', '--name', name, '--network', 'host',
      '-v', `${path.join(dir, 'iris.conf')}:/etc/nginx/conf.d/default.conf:ro`,
      '-v', `${dir}:/etc/ssl/iris:ro`,
      IMAGE,
    ]); // prettier-ignore

    // Poll over [::1]: on WSL a connect to a closed 127.0.0.1 port hangs instead of
    // being refused (#382).
    for (let i = 0; ; i++) {
      try {
        await get('/healthz', {}, '::1');
        break;
      } catch (err) {
        if (i === 100) {
          const logs = execFileSync('docker', ['logs', name], { encoding: 'utf8', stdio: 'pipe' });
          throw new Error(`nginx did not come up: ${(err as Error).message}\n${logs}`);
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    api.seen.length = 0;
    portal.seen.length = 0;
  }, 60_000);

  afterAll(async () => {
    if (DOCKER) execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    wss?.close();
    await Promise.all([api, portal].map((u) => u && new Promise((r) => u.server.close(r))));
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const spoofed = {
    'x-forwarded-for': '198.51.100.9',
    'x-real-ip': '198.51.100.9',
    // The RPC server's loopback healthcheck slot (#342): never from outside.
    'x-iris-probe': '1',
    // Next checks server actions' Origin against X-Forwarded-Host.
    'x-forwarded-host': 'evil.example',
    forwarded: 'for=198.51.100.9;host=evil.example',
  };

  function expectPeerHeaders(h: http.IncomingHttpHeaders) {
    expect(h['x-real-ip']).toBe('127.0.0.1');
    expect(h['x-forwarded-for']).toBe('127.0.0.1');
    expect(h['x-forwarded-proto']).toBe('https');
    expect(h.host).toBe(HOST);
    expect(h['x-iris-probe']).toBeUndefined();
    expect(h['x-forwarded-host']).toBe(HOST);
    expect(h.forwarded).toBeUndefined();
  }

  it('routes /v1/ to iris-api and everything else to the portal', async () => {
    expect((await get('/v1/jobs/abc')).body).toBe('api');
    expect((await get('/')).body).toBe('portal');
    expect((await get('/api/auth/get-session')).body).toBe('portal');
    expect((await get('/dashboard')).body).toBe('portal');
    expect(api.seen.map((s) => s.path)).toEqual(['/v1/jobs/abc']);
    expect(portal.seen.map((s) => s.path)).toEqual(['/', '/api/auth/get-session', '/dashboard']);
  });

  // nginx answers a prefix location's slashless form with a redirect to it; either
  // way the request itself never reaches iris-api.
  it('does not send /v1 without its slash, or /v1x, to iris-api', async () => {
    api.seen.length = 0;
    const bare = await get('/v1');
    expect(bare.status).toBe(301);
    expect(bare.headers.location).toMatch(/\/v1\/$/);
    expect((await get('/v1x/jobs')).body).toBe('portal');
    expect(api.seen).toEqual([]);
  });

  it('overwrites client-sent X-Real-IP and X-Forwarded-For with the peer address', async () => {
    api.seen.length = 0;
    portal.seen.length = 0;
    await get('/v1/jobs/abc', spoofed);
    await get('/api/auth/sign-in/email', spoofed);
    await get('/', spoofed);
    expect(api.seen).toHaveLength(1);
    expect(portal.seen).toHaveLength(2);
    for (const s of [...api.seen, ...portal.seen]) expectPeerHeaders(s.headers);
  });

  it('completes a WebSocket upgrade on /v1/rpc end to end, with the same headers', async () => {
    api.seen.length = 0;
    const ws = new WebSocket(`wss://127.0.0.1:${httpsPort}/v1/rpc`, {
      headers: { host: HOST, ...spoofed },
      ca: cert,
      // ws hands this to tls.connect; its types omit it.
      ...({ servername: HOST } as object),
    });
    const reply = await new Promise<string>((resolve, reject) => {
      ws.on('open', () => ws.send('ping'));
      ws.on('message', (m) => resolve(String(m)));
      ws.on('error', reject);
    });
    ws.close();
    expect(reply).toBe('echo:ping');
    expect(api.seen.map((s) => s.path)).toEqual(['/v1/rpc']);
    expectPeerHeaders(api.seen[0].headers);
  });

  it('sends the security headers and no version on proxied responses', async () => {
    for (const p of ['/v1/jobs/abc', '/', '/api/auth/get-session']) {
      const res = await get(p);
      expect(res.status).toBe(200);
      expectSecurityHeaders(res.headers);
    }
  });

  function expectSecurityHeaders(h: http.IncomingHttpHeaders) {
    expect(h['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(h.server).toBe('nginx');
  }

  it('redirects http to https and keeps the ACME challenge path servable', async () => {
    const plain = (p: string) =>
      new Promise<Reply>((resolve, reject) => {
        http
          .get({ host: '127.0.0.1', port: httpPort, path: p, headers: { host: HOST } }, (res) => {
            res.resume();
            res.on('end', () =>
              resolve({ status: res.statusCode!, headers: res.headers, body: '' }),
            );
          })
          .on('error', reject);
      });
    const res = await plain('/login?next=/dashboard');
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe(`https://${HOST}/login?next=/dashboard`);
    // Served from the webroot (absent here: 404), not redirected.
    expect((await plain('/.well-known/acme-challenge/token')).status).toBe(404);
  });

  // The image's OpenSSL also refuses TLS 1.1 at its default security level, so this
  // pins the outcome on the shipped image rather than the ssl_protocols line alone.
  it('refuses TLS 1.1 and accepts TLS 1.2', async () => {
    const handshake = (version: tls.SecureVersion) =>
      new Promise<string>((resolve) => {
        const s = tls.connect({
          host: '127.0.0.1',
          port: httpsPort,
          servername: HOST,
          ca: cert,
          minVersion: version,
          maxVersion: version,
          // Let the client offer TLS 1.1 at all, so the refusal is the server's.
          ciphers: 'DEFAULT@SECLEVEL=0',
        });
        s.on('secureConnect', () => {
          resolve(s.getProtocol()!);
          s.end();
        });
        s.on('error', (e) => resolve(e.message));
      });
    expect(await handshake('TLSv1.1')).toMatch(/alert protocol version/i);
    expect(await handshake('TLSv1.2')).toBe('TLSv1.2');
  });

  // Unlike TLS 1.1, nginx's default ciphers (HIGH:!aNULL:!MD5) allow this one, so the
  // refusal comes from the template's ssl_ciphers.
  it('refuses a TLS 1.2 cipher without forward secrecy, accepts an ECDHE one', async () => {
    const cipher = (name: string) =>
      new Promise<string>((resolve) => {
        const s = tls.connect({
          host: '127.0.0.1',
          port: httpsPort,
          servername: HOST,
          ca: cert,
          maxVersion: 'TLSv1.2',
          ciphers: name,
        });
        s.on('secureConnect', () => {
          resolve(s.getCipher().standardName);
          s.end();
        });
        s.on('error', (e) => resolve(e.message));
      });
    expect(await cipher('AES128-GCM-SHA256')).toMatch(/handshake failure/i);
    expect(await cipher('ECDHE-RSA-AES128-GCM-SHA256')).toBe(
      'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256',
    );
  });

  /** `n` concurrent requests as client `addr` (via the test-only realip header); 200 count. */
  async function burstAs(addr: string, p: string, n: number): Promise<number> {
    const replies = await Promise.all(
      Array.from({ length: n }, () => get(p, { 'x-test-client': addr }, '::1')),
    );
    expect(replies.every((r) => r.status === 200 || r.status === 429)).toBe(true);
    return replies.filter((r) => r.status === 200).length;
  }

  // Burst 20: a fresh budget lets ~21 of 30 through; a spent one only what refilled.
  it('throttles IPv6 clients per /64, so rotating addresses in one /64 gains nothing', async () => {
    expect(await burstAs('2001:db8:0:1::1', '/v1/jobs/v6', 30)).toBeGreaterThanOrEqual(20);
    expect(await burstAs('2001:db8:0:1::2', '/v1/jobs/v6', 30)).toBeLessThan(10);
    expect(await burstAs('2001:db8:0:2::1', '/v1/jobs/v6', 30)).toBeGreaterThanOrEqual(20);
  });

  it('throttles IPv4 clients per address', async () => {
    expect(await burstAs('192.0.2.1', '/v1/jobs/v4', 30)).toBeGreaterThanOrEqual(20);
    expect(await burstAs('192.0.2.2', '/v1/jobs/v4', 30)).toBeGreaterThanOrEqual(20);
  });

  // nginx matches locations on the decoded path, so an escaped spelling of /api/auth/
  // gets the same limit (and the portal the URI as sent).
  it('throttles an escaped /api/%61uth/ like /api/auth/', async () => {
    const p = '/api/%61uth/sign-in/email';
    portal.seen.length = 0;
    const ok = await burstAs('192.0.2.50', p, 40);
    expect(ok).toBeLessThan(40);
    expect(portal.seen.filter((s) => s.path === p)).toHaveLength(ok);
  });

  // Last: they spend 127.0.0.1's budget in both zones.
  it.each([
    ['/v1/jobs/burst', () => api],
    ['/api/auth/sign-in/email', () => portal],
  ])(
    'answers 429 per client IP past the burst on %s; the upstream never sees it',
    async (p, up) => {
      const target = up();
      target.seen.length = 0;
      const replies = await Promise.all(Array.from({ length: 50 }, () => get(p)));
      const ok = replies.filter((r) => r.status === 200);
      const limited = replies.filter((r) => r.status === 429);
      expect(ok.length + limited.length).toBe(50);
      expect(limited.length).toBeGreaterThan(0);
      expect(target.seen.filter((s) => s.path === p)).toHaveLength(ok.length);
      expectSecurityHeaders(limited[0].headers);
      // Another address has its own budget.
      expect((await get(p, {}, '::1')).status).toBe(200);
    },
  );
});
