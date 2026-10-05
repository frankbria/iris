/**
 * deploy/retention.sh (#349) against the local Docker.
 *
 * Test strategy: throwaway `node:24-alpine` containers carry the compose labels the
 * script selects by (a project of their own, services `iris` and `worker`). Each has a
 * stand-in `/app/dist/cli.js` that records its arguments and fails while /tmp/fail
 * exists, so the test proves which command ran where and what a failure does. `logger`
 * and the alert hook are stubs that append to files. Docker is required under CI and
 * skipped locally without it.
 */

import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCRIPT = path.resolve(__dirname, '..', 'deploy', 'retention.sh');
const PROJECT = `iris-retention-test-${process.pid}`;
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
  if (process.env.CI) throw new Error('Docker is required in CI for the retention test');
  console.warn('Skipping retention script tests: Docker is not available');
}

const docker = (...args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const CLI = `const fs = require('fs');
fs.appendFileSync('/tmp/calls', process.argv.slice(2).join(' ') + '\\n');
if (fs.existsSync('/tmp/fail')) { console.error('database unreachable'); process.exit(3); }
console.log(JSON.stringify({ orgsPurged: [], runsDeleted: 4 }));`;

(DOCKER ? describe : describe.skip)('deploy/retention.sh against Docker', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-retention-'));
  const bin = path.join(dir, 'bin');
  const journal = path.join(dir, 'journal.log');
  const hookLog = path.join(dir, 'hook.log');
  const hook = path.join(dir, 'alert-hook');
  const names = { iris: `${PROJECT}-iris`, worker: `${PROJECT}-worker` };

  function run(env: Record<string, string> = {}) {
    return spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        RETENTION_COMPOSE_PROJECT: PROJECT,
        RETENTION_ALERT_HOOK: hook,
        ...env,
      },
    });
  }
  const calls = (service: 'iris' | 'worker') => {
    try {
      return docker('exec', names[service], 'cat', '/tmp/calls');
    } catch {
      return '';
    }
  };

  beforeAll(() => {
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'logger'), `#!/bin/sh\necho "$*" >> ${journal}\n`, {
      mode: 0o755,
    });
    fs.writeFileSync(hook, `#!/bin/sh\necho "$1|$2" >> ${hookLog}\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'cli.js'), CLI);
    for (const [service, name] of Object.entries(names)) {
      docker(
        'run',
        '-d',
        '--name',
        name,
        '-w',
        '/app',
        '--label',
        `com.docker.compose.project=${PROJECT}`,
        '--label',
        `com.docker.compose.service=${service}`,
        '-v',
        `${path.join(dir, 'cli.js')}:/app/dist/cli.js:ro`,
        IMAGE,
        'sleep',
        '600',
      );
    }
  }, 180_000);

  afterAll(() => {
    for (const name of Object.values(names)) {
      try {
        docker('rm', '-f', name);
      } catch {
        // already gone
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('runs `admin retention` in the iris and worker containers and logs each report', () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(calls('iris')).toBe('admin retention');
    expect(calls('worker')).toBe('admin retention');
    const lines = fs.readFileSync(journal, 'utf8');
    expect(lines).toMatch(/-t iris-retention -- iris: \{"orgsPurged":\[\],"runsDeleted":4\}/);
    expect(lines).toMatch(/worker: \{"orgsPurged/);
    expect(fs.existsSync(hookLog)).toBe(false);
  }, 120_000);

  it('alerts and fails when one run fails, and still runs the other', () => {
    docker('exec', names.iris, 'touch', '/tmp/fail');
    const r = run();
    docker('exec', names.iris, 'rm', '/tmp/fail');
    expect(r.status).toBe(1);
    expect(fs.readFileSync(hookLog, 'utf8')).toContain(
      'retention-iris|retention failed in iris: database unreachable',
    );
    expect(calls('worker').split('\n')).toHaveLength(2); // it ran again
  }, 120_000);

  it('alerts when docker itself fails, and still tries the other services', () => {
    // A `docker` wrapper on PATH that fails `ps` for this run only.
    fs.writeFileSync(
      path.join(bin, 'docker'),
      `#!/bin/sh\nif [ "$1" = ps ] && [ -n "$FAIL_PS" ]; then echo "Cannot connect to the Docker daemon" >&2; exit 1; fi\nexec ${execFileSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).trim()} "$@"\n`,
      { mode: 0o755 },
    );
    try {
      const r = run({ FAIL_PS: '1' });
      expect(r.status).toBe(1);
      const hooks = fs.readFileSync(hookLog, 'utf8');
      expect(hooks).toContain(
        'retention-iris|docker ps failed: Cannot connect to the Docker daemon',
      );
      expect(hooks).toContain('retention-worker|docker ps failed');
    } finally {
      fs.rmSync(path.join(bin, 'docker'));
    }
  }, 120_000);

  it('alerts when a service has no running container', () => {
    const r = run({ RETENTION_SERVICES: 'iris portal' });
    expect(r.status).toBe(1);
    expect(fs.readFileSync(hookLog, 'utf8')).toContain(
      `retention-portal|no running portal container in compose project ${PROJECT}`,
    );
  }, 120_000);
});
