import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import path from 'path';
import { axeTagsFor } from '../src/worker';

/** `iris worker` (#267): refuses outside hosted mode, in a real process. */
describe('iris worker', () => {
  const run = (env: NodeJS.ProcessEnv) =>
    spawnSync(
      process.execPath,
      ['-r', 'ts-node/register', path.join(__dirname, '../src/cli.ts'), 'worker'],
      {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, TS_NODE_TRANSPILE_ONLY: '1', ...env },
        encoding: 'utf8',
        timeout: 60_000,
      },
    );

  it('exits 2 without IRIS_HOSTED', () => {
    const { status, stderr } = run({ IRIS_HOSTED: '' });
    expect(status).toBe(2);
    expect(stderr).toContain('hosted mode only');
  });

  it('exits 3 in hosted mode without a database URL', () => {
    const { status, stderr } = run({ IRIS_HOSTED: '1', DATABASE_URL: '', DATABASE_URL_FILE: '' });
    expect(status).toBe(3);
    expect(stderr).toContain('DATABASE_URL');
  });

  it('exits 3 in hosted mode when the database does not answer (#273)', async () => {
    // A closed port on [::1]: refused at once (a closed 127.0.0.1 port blackholes on WSL).
    const s = net.createServer();
    await new Promise<void>((resolve) => s.listen(0, '::1', resolve));
    const { port } = s.address() as net.AddressInfo;
    await new Promise((resolve) => s.close(resolve));
    const { status, stderr } = run({
      IRIS_HOSTED: '1',
      DATABASE_URL: `postgres://[::1]:${port}/x`,
    });
    expect(stderr).toContain('Cannot reach the database');
    expect(status).toBe(3);
  });
});

describe('runWorker heartbeat (#273)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-heartbeat-'));
  const file = path.join(dir, 'beat');
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('writes the file at every tick, and from a timer while a claim or job is in flight', async () => {
    const { runWorker } = await import('../src/worker');
    const stop = new AbortController();
    let claims = 0;
    const jobs = {
      // The second claim stands in for a long job: it does not return for 600ms.
      claim: jest.fn(async () => {
        if (++claims === 2) await sleep(600);
        return null;
      }),
      finish: jest.fn(),
      fail: jest.fn(),
      heartbeat: jest.fn(),
      reapStuck: jest.fn().mockResolvedValue({ requeued: 0, failed: 0 }),
    };
    const done = runWorker({
      jobs: jobs as never,
      signal: stop.signal,
      pollMs: 20,
      heartbeatFile: file,
      heartbeatMs: 50,
    });
    try {
      while (claims < 2) await sleep(5); // inside the long claim now
      fs.rmSync(file, { force: true });
      await sleep(200); // still inside it: only the timer can have written the file
      expect(claims).toBe(2);
      expect(fs.existsSync(file)).toBe(true);
    } finally {
      stop.abort();
      await done;
    }
  });
});

describe('axeTagsFor', () => {
  it('each WCAG level includes the ones below, like --tags', () => {
    expect(axeTagsFor('A')).toEqual(['wcag2a']);
    expect(axeTagsFor('AA')).toEqual(['wcag2a', 'wcag2aa']);
    expect(axeTagsFor('AAA')).toEqual(['wcag2a', 'wcag2aa', 'wcag2aaa']);
  });
});

describe('processNextA11yJob', () => {
  it('records a generic error when the result cannot be stored, and logs the detail', async () => {
    const { processNextA11yJob } = await import('../src/worker');
    const job = {
      id: 'j',
      orgId: 'o',
      apiKeyId: null,
      kind: 'a11y',
      startedAt: new Date(),
      params: { urls: ['https://a.example/'], wcagLevel: 'AA', failOn: [] },
    };
    const fail = jest.fn().mockResolvedValue(undefined);
    jest.doMock('../src/a11y/a11y-runner', () => ({
      AccessibilityRunner: class {
        async run() {
          return { summary: {}, results: [] };
        }
      },
    }));
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await processNextA11yJob({
      claim: async () => job as never,
      finish: async () => {
        throw new Error('relation "usage_events" does not exist');
      },
      fail,
      heartbeat: async () => true,
      reapStuck: async () => ({ requeued: 0, failed: 0 }),
    });
    expect(fail).toHaveBeenCalledWith(job, 'Could not store the result');
    expect(log.mock.calls.flat().join(' ')).toContain('usage_events');
    log.mockRestore();
    jest.dontMock('../src/a11y/a11y-runner');
  });
});

describe('job claims (#435)', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const job = {
    id: 'j',
    orgId: 'o',
    apiKeyId: null,
    kind: 'a11y',
    startedAt: new Date(),
    claimToken: 't',
    attempts: 1,
    params: { urls: ['https://a.example/'], wcagLevel: 'AA', failOn: [] },
  };
  // resetModules: the registry would otherwise serve an earlier test's cached runner mock.
  const slowRunner = (ms: number) => {
    jest.resetModules();
    jest.doMock('../src/a11y/a11y-runner', () => ({
      AccessibilityRunner: class {
        async run() {
          await sleep(ms);
          return { summary: {}, results: [] };
        }
      },
    }));
  };
  afterEach(() => jest.dontMock('../src/a11y/a11y-runner'));

  it('heartbeats while the job runs; a failing heartbeat is logged and the job still finishes', async () => {
    slowRunner(150);
    const { processNextA11yJob } = await import('../src/worker');
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const heartbeat = jest.fn().mockRejectedValue(new Error('db blip'));
    const finish = jest.fn().mockResolvedValue(true);
    await processNextA11yJob(
      { claim: async () => job as never, finish, fail: jest.fn(), heartbeat, reapStuck: jest.fn() },
      { heartbeatMs: 20 },
    );
    expect(heartbeat.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(heartbeat).toHaveBeenCalledWith(job);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.flat().join(' ')).toContain('db blip');
    log.mockRestore();
    const calls = heartbeat.mock.calls.length;
    await sleep(60);
    expect(heartbeat.mock.calls.length).toBe(calls); // the timer stopped with the job
  });

  it('logs a lost claim instead of throwing', async () => {
    slowRunner(0);
    const { processNextA11yJob } = await import('../src/worker');
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await processNextA11yJob({
      claim: async () => job as never,
      finish: async () => false,
      fail: jest.fn(),
      heartbeat: jest.fn(),
      reapStuck: jest.fn(),
    });
    expect(log.mock.calls.flat().join(' ')).toContain('claim on job j was lost');
    log.mockRestore();
  });

  it('stops heartbeating after the first lost claim, and says so once', async () => {
    slowRunner(200);
    const { processNextA11yJob } = await import('../src/worker');
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const heartbeat = jest.fn().mockResolvedValue(false); // reaped: the claim is gone
    await processNextA11yJob(
      {
        claim: async () => job as never,
        finish: async () => false,
        fail: jest.fn(),
        heartbeat,
        reapStuck: jest.fn(),
      },
      { heartbeatMs: 20 },
    );
    expect(heartbeat).toHaveBeenCalledTimes(1);
    const lostLines = log.mock.calls.filter((c) => String(c[0]).includes('was lost'));
    expect(lostLines).toHaveLength(1);
    log.mockRestore();
  });

  it('a heartbeat answered after a successful finish is not a lost claim', async () => {
    slowRunner(0);
    const { processNextA11yJob } = await import('../src/worker');
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    // The heartbeat blocks on finish's row lock and then sees a finished row: false.
    let release!: () => void;
    const heartbeat = jest.fn(
      () => new Promise<boolean>((resolve) => (release = () => resolve(false))),
    );
    await processNextA11yJob(
      {
        claim: async () => job as never,
        finish: async () => {
          await sleep(60); // a heartbeat tick fires meanwhile
          return true;
        },
        fail: jest.fn(),
        heartbeat,
        reapStuck: jest.fn(),
      },
      { heartbeatMs: 20 },
    );
    expect(heartbeat).toHaveBeenCalled();
    release();
    await sleep(10);
    expect(log.mock.calls.flat().join(' ')).not.toContain('was lost');
    log.mockRestore();
  });

  it('refuses a heartbeat interval too close to the reap threshold', async () => {
    const { runWorker } = await import('../src/worker');
    await expect(
      runWorker({
        jobs: {
          claim: jest.fn(),
          finish: jest.fn(),
          fail: jest.fn(),
          heartbeat: jest.fn(),
          reapStuck: jest.fn(),
        },
        heartbeatMs: 60_000,
        staleMs: 90_000,
      }),
    ).rejects.toThrow(/heartbeat/i);
  });

  it('runs the reaper before each claim, logs counts, and survives a reaper error', async () => {
    const { runWorker } = await import('../src/worker');
    const controller = new AbortController();
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const order: string[] = [];
    let ticks = 0;
    const reapStuck = jest.fn(async (_o?: unknown) => {
      order.push('reap');
      if (++ticks === 1) return { requeued: 2, failed: 1 };
      throw new Error('reaper down');
    });
    await runWorker({
      signal: controller.signal,
      pollMs: 1,
      staleMs: 1234,
      heartbeatMs: 100,
      maxAttempts: 5,
      jobs: {
        claim: async () => {
          order.push('claim');
          if (ticks === 2) controller.abort();
          return null;
        },
        finish: async () => true,
        fail: async () => true,
        heartbeat: async () => true,
        reapStuck,
      },
    });
    expect(order.slice(0, 4)).toEqual(['reap', 'claim', 'reap', 'claim']);
    expect(reapStuck).toHaveBeenCalledWith({ staleMs: 1234, maxAttempts: 5 });
    const out = log.mock.calls.flat().join(' ');
    expect(out).toContain('2 requeued, 1 failed');
    expect(out).toContain('reaper down');
    log.mockRestore();
  });
});

describe('runWorker', () => {
  it('survives a failing database, polls an empty queue, and stops on abort', async () => {
    const { runWorker } = await import('../src/worker');
    const controller = new AbortController();
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    let claims = 0;
    const done = runWorker({
      signal: controller.signal,
      pollMs: 5,
      jobs: {
        // First claim: the database is down. Then an empty queue, polled until aborted.
        claim: async () => {
          claims += 1;
          if (claims === 1) throw new Error('connection terminated');
          if (claims === 4) controller.abort();
          return null;
        },
        finish: async () => true,
        fail: async () => true,
        heartbeat: async () => true,
        reapStuck: async () => ({ requeued: 0, failed: 0 }),
      },
    });
    await done;
    expect(claims).toBe(4);
    expect(log.mock.calls.flat().join(' ')).toContain('connection terminated');
    log.mockRestore();
  });

  it('wakes from the poll wait as soon as it is aborted', async () => {
    const { runWorker } = await import('../src/worker');
    const controller = new AbortController();
    const done = runWorker({
      signal: controller.signal,
      pollMs: 60_000,
      jobs: {
        claim: async () => null,
        finish: async () => true,
        fail: async () => true,
        heartbeat: async () => true,
        reapStuck: async () => ({ requeued: 0, failed: 0 }),
      },
    });
    setImmediate(() => controller.abort());
    // A worker stuck in its 60 s wait would time this test out.
    await done;
  });
});

describe('worker logs and metrics (#275)', () => {
  const job = {
    id: 'j-obs',
    orgId: 'org-o',
    apiKeyId: null,
    kind: 'a11y',
    startedAt: new Date(),
    claimToken: 't',
    attempts: 2,
    params: { urls: ['https://a.example/'], wcagLevel: 'AA', failOn: [] },
  };
  afterEach(() => {
    delete process.env.IRIS_LOG_LEVEL;
    jest.dontMock('../src/a11y/a11y-runner');
  });

  /** A fresh registry with a runner that succeeds, or throws `fails`. */
  async function load(fails?: string) {
    jest.resetModules();
    jest.doMock('../src/a11y/a11y-runner', () => ({
      AccessibilityRunner: class {
        async run() {
          if (fails) throw new Error(fails);
          return { summary: {}, results: [] };
        }
      },
    }));
    const worker = await import('../src/worker');
    const { metrics } = await import('../src/metrics');
    return { ...worker, metrics };
  }

  const jobsWith = (over: Record<string, unknown> = {}) => ({
    claim: async () => job as never,
    finish: async () => true,
    fail: async () => true,
    heartbeat: async () => true,
    reapStuck: async () => ({ requeued: 0, failed: 0 }),
    ...over,
  });

  it('logs claim and outcome with latency and attempts, and counts each outcome', async () => {
    process.env.IRIS_LOG_LEVEL = 'info';
    const { processNextA11yJob, metrics } = await load();
    const out = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await processNextA11yJob(jobsWith());
    await processNextA11yJob(jobsWith({ finish: async () => false })); // reaped meanwhile
    const lines = out.mock.calls.map((c) => String(c[0]));
    out.mockRestore();
    expect(lines[0]).toMatch(/^\[iris\] job claimed jobId=j-obs orgId=org-o kind=a11y attempts=2$/);
    expect(lines[1]).toMatch(/^\[iris\] job finished jobId=j-obs .*latencyMs=\d+$/);
    expect(lines.some((l) => /job lost/.test(l))).toBe(true);
    const text = metrics.render();
    expect(text).toMatch(/^iris_jobs_total\{kind="a11y",outcome="finished"\} 1$/m);
    expect(text).toMatch(/^iris_jobs_total\{kind="a11y",outcome="lost"\} 1$/m);
    expect(text).toMatch(/^iris_job_duration_seconds_count\{kind="a11y"\} 2$/m);
  });

  it('counts a job that could not run as error, and logs its reason', async () => {
    const { processNextA11yJob, metrics } = await load('net::ERR_NAME_NOT_RESOLVED');
    const out = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await processNextA11yJob(jobsWith());
    const text = out.mock.calls.flat().join('\n');
    out.mockRestore();
    expect(text).toMatch(/job error jobId=j-obs .*err=net::ERR_NAME_NOT_RESOLVED/);
    expect(metrics.render()).toMatch(/^iris_jobs_total\{kind="a11y",outcome="error"\} 1$/m);
  });

  it('samples the queue depth each tick and counts reaped jobs', async () => {
    const { runWorker, metrics } = await load();
    const controller = new AbortController();
    const out = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    let ticks = 0;
    await runWorker({
      signal: controller.signal,
      pollMs: 1,
      jobs: jobsWith({
        claim: async () => {
          if (++ticks === 2) controller.abort();
          return null;
        },
        reapStuck: async () =>
          ticks === 0 ? { requeued: 2, failed: 1 } : { requeued: 0, failed: 0 },
        queueDepth: async () => 7 + ticks,
      }),
    });
    out.mockRestore();
    const text = metrics.render();
    expect(text).toMatch(/^iris_job_queue_depth 8$/m); // the second tick's sample
    expect(text).toMatch(/^iris_jobs_reaped_total\{result="requeued"\} 2$/m);
    expect(text).toMatch(/^iris_jobs_reaped_total\{result="failed"\} 1$/m);
  });
});
