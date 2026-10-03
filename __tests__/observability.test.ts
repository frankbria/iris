/**
 * The logger and metrics primitives (#275): redaction, levels, the Prometheus text
 * format, and the loopback-only metrics listener. Request logging over real sockets is
 * in `protocol-observability.test.ts`.
 *
 * `isHostedMode()` is memoized per module registry, so each mode loads its own copy of
 * the logger through `jest.isolateModules`.
 */

import * as http from 'http';
import type { AddressInfo } from 'net';
import { Registry, serveMetrics, isLoopbackHost } from '../src/metrics';

type LogModule = typeof import('../src/log') & {
  metrics: (typeof import('../src/metrics'))['metrics'];
};

function loadLog(hosted: boolean): LogModule {
  const saved = process.env.IRIS_HOSTED;
  process.env.IRIS_HOSTED = hosted ? '1' : '';
  let mod!: LogModule;
  jest.isolateModules(() => {
    mod = { ...require('../src/log'), metrics: require('../src/metrics').metrics };
    mod.log('debug', 'warm-up'); // reads (and memoizes) the switch now
  });
  if (saved === undefined) delete process.env.IRIS_HOSTED;
  else process.env.IRIS_HOSTED = saved;
  return mod;
}

function capture(fn: () => void): string[] {
  const lines: string[] = [];
  const spy = jest.spyOn(console, 'error').mockImplementation((l: unknown) => {
    lines.push(String(l));
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

afterEach(() => {
  delete process.env.IRIS_LOG_LEVEL;
});

describe('log', () => {
  it('writes one JSON object per line in hosted mode, with ts, level, msg and fields', () => {
    const { log } = loadLog(true);
    const [line] = capture(() => log('info', 'rpc request', { requestId: 'r1', latencyMs: 3 }));
    const obj = JSON.parse(line);
    expect(obj).toMatchObject({ level: 'info', msg: 'rpc request', requestId: 'r1', latencyMs: 3 });
    expect(new Date(obj.ts).toISOString()).toBe(obj.ts);
  });

  it('writes a human line locally, and only warn and above by default', () => {
    const { log } = loadLog(false);
    const lines = capture(() => {
      log('info', 'quiet');
      log('warn', 'job failed', { jobId: 'j1' });
    });
    expect(lines).toEqual(['[iris] job failed jobId=j1']);
  });

  it('honours IRIS_LOG_LEVEL in either direction', () => {
    const { log } = loadLog(true);
    process.env.IRIS_LOG_LEVEL = 'error';
    expect(capture(() => log('warn', 'dropped'))).toEqual([]);
    process.env.IRIS_LOG_LEVEL = 'DEBUG';
    expect(capture(() => log('debug', 'kept'))).toHaveLength(1);
    // Not a level (and not a prototype key either): the default applies.
    process.env.IRIS_LOG_LEVEL = 'toString';
    expect(capture(() => log('info', 'kept'))).toHaveLength(1);
  });

  it('never prints a secret-named field, URL userinfo or a bearer token', () => {
    const { log } = loadLog(true);
    const MARK = 'm4rk3r-s3cret';
    const out = capture(() =>
      log('error', `could not reach postgres://iris:${MARK}@db:5432/iris`, {
        authorization: `Bearer ${MARK}`,
        headers: { Authorization: `Bearer ${MARK}`, cookie: MARK },
        apiKey: MARK,
        key: MARK,
        databaseUrl: MARK,
        smtp_url: MARK,
        password: MARK,
        action: { type: 'fill', selector: '#pw', text: MARK, value: MARK },
        err: new Error(`smtp://user:${MARK}@mail.example failed; sent Bearer ${MARK}`),
        nested: [[[[[MARK]]]]],
        keyId: 'key-id-1',
      }),
    ).join('\n');
    expect(out).not.toContain(MARK);
    const obj = JSON.parse(out);
    expect(obj.keyId).toBe('key-id-1');
    expect(obj.action).toMatchObject({ type: 'fill', selector: '#pw', text: '[redacted]' });
    expect(obj.msg).toBe('could not reach postgres://[redacted]@db:5432/iris');
  });

  it('redacts request payload fields: instruction, params, body, text, value', () => {
    const { redact } = loadLog(true);
    const MARK = 'payl0ad-m4rk';
    const out = JSON.stringify(
      redact({ instruction: MARK, params: { x: MARK }, body: MARK, text: MARK, value: MARK }),
    );
    expect(out).not.toContain(MARK);
  });

  it('cuts secrets out of free text: query tokens, Basic auth, embedded iris_ keys', () => {
    const { redact } = loadLog(true);
    const KEY = 'iris_' + 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';
    const text = [
      'page.goto: net::ERR_ABORTED at https://a.example/x?token=t0k3n&page=2',
      'https://b.example/?a=1&api_key=k3y&X-Amz-Signature=s1g&client_secret=s3c',
      '?password=pw;&auth=au7h#frag',
      'sent Basic dXNlcjpwYXNz to the proxy',
      `connect failed with ${KEY}.`,
      'metric iris_request_duration_seconds is fine, so is iris_jobs_total',
      // A URL parser reads %74oken as token: an encoded name is no disguise.
      'https://d.example/r?%74oken=enc0ded&p%61ge=3&%E0%A4=x',
    ].join('\n');
    const out = redact(text) as string;
    for (const secret of [
      't0k3n',
      'k3y',
      's1g',
      's3c',
      '=pw',
      'au7h',
      'dXNlcjpwYXNz',
      KEY,
      'enc0ded',
    ]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('page=2');
    expect(out).toContain('p%61ge=3');
    expect(out).toContain('#frag');
    expect(out).toContain('iris_request_duration_seconds');
    expect(out).toContain('iris_jobs_total');
    // Error messages go through the same pass.
    expect(redact(new Error('GET https://c.example/?sig=zzz9 failed'))).not.toContain('zzz9');
  });

  it('counts every error-level line in iris_errors_total, logged or not', () => {
    const { log, metrics } = loadLog(true);
    const before = metrics.counter('iris_errors_total', '').get();
    process.env.IRIS_LOG_LEVEL = 'error';
    capture(() => {
      log('error', 'one');
      log('warn', 'not an error');
    });
    process.env.IRIS_LOG_LEVEL = 'error';
    capture(() => log('error', 'two'));
    expect(metrics.counter('iris_errors_total', '').get()).toBe(before + 2);
  });

  it('does not throw on values JSON cannot encode', () => {
    const { log } = loadLog(true);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const out = capture(() => log('info', 'odd', { n: BigInt(7), cyclic }));
    expect(JSON.parse(out[0])).toMatchObject({ n: '7' });
  });
});

describe('Prometheus text format', () => {
  it('renders HELP, TYPE, escaped labels, and cumulative histogram buckets', () => {
    const r = new Registry();
    const c = r.counter('t_requests_total', 'Requests\nanswered');
    c.inc({ method: 'a"b\\c\nd', outcome: 'ok' });
    c.inc({ outcome: 'ok', method: 'a"b\\c\nd' }, 2); // same series, other key order
    c.inc({}, -5); // ignored
    r.gauge('t_sessions', 'Open sessions', () => 3);
    r.gauge('t_by_kind', 'Per kind', () => [[{ kind: 'x' }, 1.5]]);
    const h = r.histogram('t_seconds', 'Latency', [1, 0.1]);
    h.observe({ method: 'm' }, 0.05);
    h.observe({ method: 'm' }, 0.5);
    h.observe({ method: 'm' }, 7);
    expect(r.render()).toBe(
      [
        '# HELP t_requests_total Requests\\nanswered',
        '# TYPE t_requests_total counter',
        't_requests_total{method="a\\"b\\\\c\\nd",outcome="ok"} 3',
        '# HELP t_sessions Open sessions',
        '# TYPE t_sessions gauge',
        't_sessions 3',
        '# HELP t_by_kind Per kind',
        '# TYPE t_by_kind gauge',
        't_by_kind{kind="x"} 1.5',
        '# HELP t_seconds Latency',
        '# TYPE t_seconds histogram',
        't_seconds_bucket{method="m",le="0.1"} 1',
        't_seconds_bucket{method="m",le="1"} 2',
        't_seconds_bucket{method="m",le="+Inf"} 3',
        't_seconds_sum{method="m"} 7.55',
        't_seconds_count{method="m"} 3',
        '',
      ].join('\n'),
    );
  });

  it('skips a gauge whose collector throws, and keeps the rest', () => {
    const r = new Registry();
    r.gauge('t_bad', 'x', () => {
      throw new Error('boom');
    });
    r.gauge('t_good', 'y', () => 1);
    expect(r.render()).toBe('# HELP t_good y\n# TYPE t_good gauge\nt_good 1\n');
  });
});

describe('serveMetrics', () => {
  const get = (port: number, path: string, method = 'GET') =>
    new Promise<{ status: number; type?: string; body: string }>((resolve, reject) => {
      http
        .request({ host: '127.0.0.1', port, path, method }, (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () =>
            resolve({ status: res.statusCode!, type: res.headers['content-type'], body }),
          );
        })
        .on('error', reject)
        .end();
    });

  it('refuses a non-loopback bind before listening', async () => {
    for (const host of ['0.0.0.0', '::', '192.0.2.1', 'example.com', '']) {
      expect(isLoopbackHost(host)).toBe(false);
      await expect(serveMetrics(0, host, new Registry())).rejects.toThrow(/loopback only/);
    }
    for (const host of ['127.0.0.1', '127.1.2.3', '::1', 'localhost']) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  it('serves the registry at /metrics with iris_up and the start time; 404 elsewhere', async () => {
    const r = new Registry();
    r.counter('t_total', 'x').inc();
    const server = await serveMetrics(0, '127.0.0.1', r);
    try {
      const { port } = server.address() as AddressInfo;
      const res = await get(port, '/metrics');
      expect(res.status).toBe(200);
      expect(res.type).toBe('text/plain; version=0.0.4; charset=utf-8');
      expect(res.body).toMatch(/^t_total 1$/m);
      expect(res.body).toMatch(/^iris_up 1$/m);
      const start = Number(res.body.match(/^iris_start_time_seconds (\S+)$/m)![1]);
      expect(Math.abs(start - (Date.now() / 1000 - process.uptime()))).toBeLessThan(5);
      expect((await get(port, '/')).status).toBe(404);
      expect((await get(port, '/metrics', 'POST')).status).toBe(404);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('rejects when the port is taken', async () => {
    const server = await serveMetrics(0, '127.0.0.1', new Registry());
    try {
      const { port } = server.address() as AddressInfo;
      await expect(serveMetrics(port, '127.0.0.1', new Registry())).rejects.toThrow(/EADDRINUSE/);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

/**
 * `--metrics-port` on the real commands, spawned (ts-node, transpile-only): the flag
 * reaches the listener, and a port that cannot be bound is an exit 3, not a server
 * running without its metrics. The worker case needs Postgres for its startup probe.
 */
describe('--metrics-port', () => {
  const { spawn } = require('child_process') as typeof import('child_process');
  const path = require('path') as typeof import('path');
  const net = require('net') as typeof import('net');

  const freePort = () =>
    new Promise<number>((resolve) => {
      const srv = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = srv.address() as AddressInfo;
        srv.close(() => resolve(port));
      });
    });

  function start(args: string[], env: NodeJS.ProcessEnv) {
    const proc = spawn(
      process.execPath,
      ['-r', 'ts-node/register', path.join(__dirname, '../src/cli.ts'), ...args],
      {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, TS_NODE_TRANSPILE_ONLY: '1', ...env },
      },
    );
    let out = '';
    proc.stdout!.on('data', (d) => (out += d));
    proc.stderr!.on('data', (d) => (out += d));
    const exit = new Promise<number | null>((r) => proc.on('exit', r));
    return { proc, exit, out: () => out };
  }

  async function scrapeWhenUp(port: number): Promise<string> {
    for (let i = 0; ; i++) {
      try {
        return await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
      } catch (err) {
        if (i > 300) throw err;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }

  it('iris connect serves metrics on loopback and exits 3 when the port is taken', async () => {
    const [port, metricsPort] = [await freePort(), await freePort()];
    const env = { IRIS_CONNECT_TOKEN: 'metrics-test-token' };
    const c = start(['connect', String(port), '--metrics-port', String(metricsPort)], env);
    try {
      const text = await scrapeWhenUp(metricsPort);
      expect(text).toMatch(/^iris_up 1$/m);
      expect(text).toMatch(/^iris_sessions_active 0$/m);
      // A second server on the same metrics port refuses to start.
      const taken = start(
        ['connect', String(await freePort()), '--metrics-port', String(metricsPort)],
        env,
      );
      expect(await taken.exit).toBe(3);
      expect(taken.out()).toMatch(/Cannot serve metrics on 127\.0\.0\.1:\d+: .*EADDRINUSE/);
    } finally {
      c.proc.kill('SIGKILL');
    }
  }, 60_000);

  (process.env.IRIS_TEST_DATABASE_URL ? it : it.skip)(
    'iris worker serves metrics on its own port',
    async () => {
      const metricsPort = await freePort();
      const w = start(['worker', '--metrics-port', String(metricsPort)], {
        IRIS_HOSTED: '1',
        DATABASE_URL: process.env.IRIS_TEST_DATABASE_URL,
      });
      try {
        const text = await scrapeWhenUp(metricsPort);
        expect(text).toMatch(/^iris_up 1$/m);
        expect(text).toMatch(/^# TYPE iris_job_queue_depth gauge$/m);
      } finally {
        w.proc.kill('SIGKILL');
      }
    },
    60_000,
  );
});

/**
 * Hosted output stays one JSON object per line (#275): modules that the hosted server or
 * worker reach and that are shared with the local CLI print through `hostedLog()`, whose
 * local branch keeps the CLI's own console output. A bare console call there is a
 * plain-text line in the middle of the JSON stream.
 */
describe('hosted paths log through the logger', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  it.each([
    'src/translator.ts',
    'src/db/postgres.ts',
    'src/ai-client/factory.ts',
    'src/ai-client/base.ts',
    'src/ai-client/text.ts',
    'src/ai-client/cost-tracker.ts',
    'src/ai-client/smart-client.ts',
    'src/billing/usage.ts',
    'src/protocol.ts',
    'src/jobs-api.ts',
    'src/worker.ts',
  ])('%s has no console call outside a hostedLog local branch', (file) => {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const bare = source.match(/(?<!\(\) =>\s*)console\.(error|warn|log)\(/g) ?? [];
    expect(bare).toEqual([]);
  });

  it('hostedLog: a JSON line hosted, the local callback otherwise', () => {
    const hosted = loadLog(true);
    const local = jest.fn();
    const out = capture(() => hosted.hostedLog('error', 'failed', { err: 'x' }, local));
    expect(local).not.toHaveBeenCalled();
    expect(JSON.parse(out[0])).toMatchObject({ level: 'error', msg: 'failed', err: 'x' });
    const plain = loadLog(false);
    expect(capture(() => plain.hostedLog('error', 'failed', {}, local))).toEqual([]);
    expect(local).toHaveBeenCalledTimes(1);
  });
});
