/**
 * scripts/rollout-watch.js (#316), the client-side record deploy-staging keeps of a deploy:
 * against a local server, a held keep-alive session across a "switch" (the upstreams
 * file changing), and fresh requests that fail when nothing listens.
 */
import { spawn } from 'child_process';
import { once } from 'events';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { closedPort } from './utils/ports';

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'rollout-watch.js');

describe('scripts/rollout-watch.js', () => {
  let server: http.Server;
  let port: number;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-watch-'));
  const upstreams = path.join(dir, 'upstreams.conf');

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.statusCode = req.url === '/health/ready' || req.url === '/api/health' ? 200 : 404;
      res.end('ok');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function watch(portalPort: number, switchAfterMs: number) {
    fs.writeFileSync(upstreams, 'old\n');
    const child = spawn(process.execPath, [
      SCRIPT,
      String(port),
      String(portalPort),
      upstreams,
      '600',
      '20000',
      '100',
    ]);
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    const timer = setTimeout(() => fs.writeFileSync(upstreams, 'new\n'), switchAfterMs);
    const [code] = await once(child, 'close');
    clearTimeout(timer);
    expect(code).toBe(0);
    return JSON.parse(out);
  }

  it('keeps one socket for the held session across the switch, and stops after it', async () => {
    const r = await watch(port, 500);
    expect(r.switchedAfterMs).toBeGreaterThan(0);
    expect(r.held).toEqual({
      requests: expect.any(Number),
      failed: 0,
      sockets: 1,
      spannedSwitch: true,
    });
    expect(r.held.requests).toBeGreaterThan(2);
    expect(r.fresh.failed).toBe(0);
    expect(r.failures).toEqual([]);
  }, 30_000);

  it('records a failed fresh request with what it saw', async () => {
    const r = await watch(await closedPort('127.0.0.1'), 300);
    expect(r.fresh.failed).toBeGreaterThan(0);
    expect(r.failures[0]).toMatch(/fresh portal: ECONNREFUSED/);
    expect(r.held.failed).toBe(0);
  }, 30_000);
});
