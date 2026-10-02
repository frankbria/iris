/**
 * deploy/watchdog.sh (#275) against the local Docker.
 *
 * Test strategy: throwaway `node:24-alpine` containers carry the compose labels the
 * watchdog selects by (a project of their own, services `iris` and `crashy`). The `iris`
 * one serves the file /tmp/metrics on 127.0.0.1:9464 inside the container, like the real
 * metrics listener, and its healthcheck fails while /tmp/sick exists, so a test turns it
 * unhealthy with `docker exec touch`. The file survives a restart, so it stays sick and
 * the restart cap is reached. The alert hook and `logger` are stubs that append to files.
 *
 * Cases run in order and share the containers and the state directory. Docker is
 * required under CI and skipped locally without it.
 */

import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCRIPT = path.resolve(__dirname, '..', 'deploy', 'watchdog.sh');
const PROJECT = `iris-watchdog-test-${process.pid}`;
const IMAGE = 'node:24-alpine';

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
  if (process.env.CI) throw new Error('Docker is required in CI for the watchdog test');
  console.warn('Skipping watchdog tests: Docker is not available');
}

const docker = (...args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const SERVER = `require('http').createServer((q, s) => {
  try { s.end(require('fs').readFileSync('/tmp/metrics')); } catch { s.statusCode = 500; s.end(); }
}).listen(9464, '127.0.0.1')`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('deploy/watchdog.sh: settings', () => {
  it.each([
    ['WATCHDOG_MAX_RESTARTS', 'abc'],
    ['WATCHDOG_ERROR_PERCENT', '0'],
    ['WATCHDOG_METRICS', 'iris'],
  ])('refuses %s=%s before doing anything', (name, value) => {
    const r = spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, WATCHDOG_STATE_DIR: '/nonexistent/x', [name]: value },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(name);
  });
});

(DOCKER ? describe : describe.skip)('deploy/watchdog.sh against Docker', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-watchdog-'));
  const state = path.join(dir, 'state');
  const bin = path.join(dir, 'bin');
  const hookLog = path.join(dir, 'hook.log');
  const journal = path.join(dir, 'journal.log');
  const hook = path.join(dir, 'alert-hook');
  const iris = `${PROJECT}-iris`;
  const crashy = `${PROJECT}-crashy`;

  function run(env: Record<string, string> = {}) {
    const r = spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        WATCHDOG_COMPOSE_PROJECT: PROJECT,
        WATCHDOG_STATE_DIR: state,
        WATCHDOG_ALERT_HOOK: hook,
        WATCHDOG_METRICS: 'iris:9464',
        WATCHDOG_ALERT_REPEAT: '0',
        ...env,
      },
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  }

  /** Hook calls since the last read, as `key|message`. */
  function alerts(): string[] {
    if (!fs.existsSync(hookLog)) return [];
    const lines = fs.readFileSync(hookLog, 'utf8').split('\n').filter(Boolean);
    fs.rmSync(hookLog);
    return lines;
  }

  const metrics = (total: number, errors: number) =>
    docker(
      'exec',
      iris,
      'sh',
      '-c',
      `printf '%s\\n' '# TYPE iris_requests_total counter' ` +
        `'iris_requests_total{method="getStatus",outcome="ok"} ${total - errors}' ` +
        `'iris_requests_total{method="executeBrowserAction",outcome="error"} ${errors}' ` +
        `'iris_up 1' > /tmp/metrics`,
    );

  async function waitFor(what: string, check: () => boolean, ms = 60_000) {
    for (const start = Date.now(); !check(); await sleep(250)) {
      if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    }
  }
  const health = (name: string) => docker('inspect', '-f', '{{.State.Health.Status}}', name);
  const startedAt = (name: string) => docker('inspect', '-f', '{{.State.StartedAt}}', name);

  const labels = (service: string) => [
    '--label',
    `com.docker.compose.project=${PROJECT}`,
    '--label',
    `com.docker.compose.service=${service}`,
  ];

  beforeAll(async () => {
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'logger'), `#!/bin/sh\necho "$@" >> ${journal}\n`, {
      mode: 0o755,
    });
    fs.writeFileSync(hook, `#!/bin/sh\necho "$1|$2" >> ${hookLog}\n`, { mode: 0o755 });
    // prettier-ignore
    docker('run', '-d', '--name', iris, ...labels('iris'),
      '--health-cmd', 'test ! -e /tmp/sick', '--health-interval', '1s',
      '--health-retries', '1', '--health-timeout', '5s',
      IMAGE, 'node', '-e', SERVER);
    await waitFor('the iris container to be healthy', () => health(iris) === 'healthy');
  }, 180_000);

  afterAll(() => {
    if (DOCKER) {
      spawnSync('docker', ['rm', '-f', iris, crashy], { stdio: 'ignore' });
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a healthy project with clean metrics raises nothing', () => {
    metrics(100, 0);
    const r = run();
    expect(r.status).toBe(0);
    expect(r.out).toContain(`checked project ${PROJECT}`);
    expect(alerts()).toEqual([]);
    expect(fs.statSync(state).mode & 0o777).toBe(0o700);
  });

  it('alerts when the error share over the window passes the threshold, once while it lasts', () => {
    metrics(200, 50); // 50 of the last 100 requests failed
    expect(run({ WATCHDOG_ALERT_REPEAT: '3600' }).status).toBe(0);
    const [alert, ...rest] = alerts();
    expect(rest).toEqual([]);
    expect(alert).toMatch(/^error-rate-iris\|iris: 50 of 100 requests or jobs ended in error/);
    expect(fs.readFileSync(journal, 'utf8')).toMatch(
      /^-p crit -t iris-watchdog -- IRIS ALERT: iris: 50 of 100/m,
    );
    // Still true on the next run: not repeated within WATCHDOG_ALERT_REPEAT.
    expect(run({ WATCHDOG_ALERT_REPEAT: '3600' }).out).toMatch(/still: iris: 50 of 100/);
    expect(alerts()).toEqual([]);
  });

  it('does not alert below the threshold or the minimum volume, and restarts the window on a counter reset', () => {
    fs.rmSync(path.join(state, 'rate.iris'));
    metrics(1000, 0);
    run();
    metrics(1100, 4); // 4% of 100
    run();
    metrics(1110, 10); // 10 of 110 overall, but under WATCHDOG_MIN_REQUESTS=200
    run({ WATCHDOG_MIN_REQUESTS: '200' });
    metrics(10, 5); // the process restarted: no 5-of-10 against the old counters
    run();
    expect(alerts()).toEqual([]);
  });

  it('alerts when a scrape fails: no container for a target, or nothing on its port', () => {
    const r = run({ WATCHDOG_METRICS: 'iris:9999 worker:9465' });
    expect(r.status).toBe(0);
    const got = alerts();
    expect(got).toContainEqual(
      expect.stringMatching(/^scrape-iris\|metrics scrape of iris failed/),
    );
    expect(got).toContainEqual(
      `scrape-worker|no running worker container in ${PROJECT}: metrics scrape failed`,
    );
  });

  it('restarts an unhealthy container, at most WATCHDOG_MAX_RESTARTS an hour, then alerts', async () => {
    docker('exec', iris, 'touch', '/tmp/sick');
    for (const n of [1, 2]) {
      await waitFor('unhealthy', () => health(iris) === 'unhealthy');
      const before = startedAt(iris);
      expect(run({ WATCHDOG_MAX_RESTARTS: '2' }).status).toBe(0);
      expect(startedAt(iris)).not.toBe(before);
      expect(alerts()).toEqual([
        expect.stringMatching(
          new RegExp(
            `^restarted-iris\\|iris \\(\\w+\\) was unhealthy: restarted \\(${n}/2 this hour\\)$`,
          ),
        ),
      ]);
    }
    await waitFor('unhealthy', () => health(iris) === 'unhealthy');
    const before = startedAt(iris);
    run({ WATCHDOG_MAX_RESTARTS: '2' });
    expect(startedAt(iris)).toBe(before); // the cap holds: left alone
    expect(alerts()).toEqual([
      expect.stringMatching(/^restart-cap-iris\|iris \(\w+\) is unhealthy; restarted 2 times/),
    ]);
    docker('exec', iris, 'rm', '/tmp/sick');
  }, 120_000);

  it('alerts when Docker restarted a container that exited', async () => {
    // prettier-ignore
    docker('run', '-d', '--name', crashy, ...labels('crashy'), '--restart', 'unless-stopped',
      IMAGE, 'node', '-e', 'setTimeout(() => process.exit(1), 1500)');
    run(); // records its restart count
    alerts();
    await waitFor(
      'a restart',
      () => Number(docker('inspect', '-f', '{{.RestartCount}}', crashy)) > 0,
    );
    run();
    expect(alerts()).toContainEqual(
      expect.stringMatching(/^exited-crashy\|crashy \(\w{12}\) exited and Docker restarted it/),
    );
  }, 60_000);

  it('still writes the journal entry when no hook is installed', () => {
    fs.rmSync(journal, { force: true });
    run({ WATCHDOG_METRICS: 'worker:9465', WATCHDOG_ALERT_HOOK: path.join(dir, 'none') });
    expect(fs.readFileSync(journal, 'utf8')).toMatch(/IRIS ALERT: no running worker container/);
    expect(alerts()).toEqual([]);
  });
});
