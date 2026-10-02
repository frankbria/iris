/**
 * deploy/deploy.sh (#273) against the local Docker.
 *
 * Test strategy: a throwaway registry on a loopback port, so the script deploys real
 * `@sha256:` digest refs and really pulls them. The images are busybox builds that
 * only model what the script depends on: a migration that exits 0 or 1
 * (`dist/db/migrate.js`), an SMTP check (`verify/.../verify-smtp.js`) and a
 * healthcheck that passes or fails. Their `node` is a shell wrapper, so those
 * "scripts" are shell; busybox keeps a push to a couple of seconds. The compose file is a test one with the
 * production file's service names; the production file itself is pinned by
 * container-config.test.ts.
 *
 * Docker is required under CI and skipped (with a warning) locally without it.
 */

import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCRIPT = path.resolve(__dirname, '..', 'deploy', 'deploy.sh');
const BASE = 'busybox:1.37';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const DOCKER = dockerAvailable();
if (!DOCKER) {
  if (process.env.CI) throw new Error('Docker is required in CI for the deploy script test');
  console.warn('Skipping deploy script tests: Docker or docker compose is not available');
}

const docker = (...args: string[]) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000, // a wedged daemon fails the test instead of hanging it
    // The daemon's own builder, so a build lands in its image store even where
    // setup-buildx-action made a docker-container builder current (CI).
    env: { ...process.env, BUILDX_BUILDER: 'default' },
  }).trim();

const COMPOSE = `
name: iris-deploy-test
x-app: &app
  init: true
  stop_grace_period: 1s
  command: ['sleep', 'infinity']
  healthcheck:
    test: ['CMD-SHELL', 'exit $$(cat /app/health)']
    interval: 1s
    timeout: 2s
    retries: 2
  depends_on:
    postgres:
      condition: service_healthy
services:
  postgres:
    image: \${DB_IMAGE:?}
    init: true
    command: ['sleep', 'infinity']
    healthcheck:
      test: ['CMD', 'true']
      interval: 1s
  iris:
    <<: *app
    image: \${IRIS_IMAGE:?}
  worker:
    <<: *app
    image: \${IRIS_IMAGE:?}
  portal:
    <<: *app
    image: \${PORTAL_IMAGE:?}
`;

(DOCKER ? describe : describe.skip)('deploy/deploy.sh', () => {
  const registry = `iris-deploy-test-registry-${process.pid}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-deploy-'));
  const refs: Record<string, string> = {};
  let repo = '';

  /**
   * Builds and pushes one image; returns its digest ref. COPY only, no RUN: each RUN
   * is a container, which costs tens of seconds on a loaded WSL daemon.
   */
  function image(name: string, { migrate = 0, health = 0 } = {}): string {
    const ctx = path.join(dir, `ctx-${name}`);
    const put = (file: string, body: string, mode = 0o644) => {
      fs.mkdirSync(path.dirname(path.join(ctx, file)), { recursive: true });
      fs.writeFileSync(path.join(ctx, file), body, { mode });
    };
    put('node', '#!/bin/sh\nexec sh "$@"\n', 0o755);
    put('app/dist/db/migrate.js', `exit ${migrate}\n`);
    put('app/verify/apps/portal/scripts/verify-smtp.js', 'exit 0\n');
    put('app/health', `${health}\n`);
    put('app/version', `${name}\n`);
    put('Dockerfile', `FROM ${BASE}\nCOPY node /bin/node\nCOPY app /app\nWORKDIR /app\n`);
    const tag = `${repo}:${name}`;
    docker('build', '-q', '-t', tag, ctx);
    docker('push', '-q', tag);
    const digest = docker('inspect', '-f', '{{index .RepoDigests 0}}', tag);
    docker('rmi', tag); // the deploy must pull it by digest
    return digest;
  }

  function deploy(iris: string, portal: string) {
    const r = spawnSync('bash', [SCRIPT], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        IRIS_IMAGE: iris,
        PORTAL_IMAGE: portal,
        DB_IMAGE: refs.db,
        DEPLOY_WAIT_TIMEOUT: '30',
      },
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  }

  /** service -> [image ref, container id] of what is running now. */
  function running(): Record<string, [string, string]> {
    const out: Record<string, [string, string]> = {};
    for (const service of ['iris', 'worker', 'portal']) {
      const id = execFileSync('docker', ['compose', 'ps', '-q', service], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, IRIS_IMAGE: 'x', PORTAL_IMAGE: 'x', DB_IMAGE: 'x' },
      }).trim();
      out[service] = [id && docker('inspect', '-f', '{{.Config.Image}}', id), id];
    }
    return out;
  }

  const down = () =>
    spawnSync('docker', ['compose', 'down', '-v', '--remove-orphans', '-t', '1'], {
      cwd: dir,
      env: { ...process.env, IRIS_IMAGE: 'x', PORTAL_IMAGE: 'x', DB_IMAGE: 'x' },
    });

  const envFile = () => fs.readFileSync(path.join(dir, '.env'), 'utf8');

  beforeAll(() => {
    docker('pull', '-q', BASE);
    docker('run', '-d', '--name', registry, '-p', '127.0.0.1::5000', 'registry:2');
    const port = docker('port', registry, '5000/tcp').split(':').pop();
    repo = `127.0.0.1:${port}/iris-deploy-test`;
    fs.writeFileSync(path.join(dir, 'docker-compose.yml'), COMPOSE);
    refs.db = image('db');
    refs.v1 = image('v1');
    refs.v2 = image('v2');
    refs.badMigration = image('bad-migration', { migrate: 1 });
    refs.unhealthy = image('unhealthy', { health: 1 });
  }, 120_000);

  afterAll(() => {
    down();
    spawnSync('docker', ['rm', '-f', '-v', registry]);
    for (const ref of Object.values(refs)) spawnSync('docker', ['rmi', ref]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('first deploy of an unhealthy image: fails, and says there is nothing to roll back to', () => {
    const r = deploy(refs.unhealthy, refs.unhealthy);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/no previous images to roll back to/);
    down();
  }, 90_000);

  it('deploys by digest, .env names what runs, and a rerun of the same digests succeeds', () => {
    for (let run = 0; run < 2; run++) {
      const r = deploy(refs.v2, refs.v1);
      expect(r.out).toMatch(/healthy/);
      expect(r.status).toBe(0);
      const now = running();
      expect([now.iris[0], now.worker[0], now.portal[0]]).toEqual([refs.v2, refs.v2, refs.v1]);
      expect(envFile()).toContain(`IRIS_IMAGE=${refs.v2}\nPORTAL_IMAGE=${refs.v1}\n`);
    }
  }, 120_000);

  it('a failed migration changes nothing: same containers, same images, exit 1', () => {
    const before = running();
    const r = deploy(refs.badMigration, refs.badMigration);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/migration failed/);
    expect(running()).toEqual(before);
    expect(envFile()).toContain(`IRIS_IMAGE=${refs.v2}\nPORTAL_IMAGE=${refs.v1}\n`);
  }, 90_000);

  it('an unhealthy release rolls back to the recorded images and exits 1', () => {
    const r = deploy(refs.unhealthy, refs.unhealthy);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/rolled back/);
    const now = running();
    expect([now.iris[0], now.worker[0], now.portal[0]]).toEqual([refs.v2, refs.v2, refs.v1]);
    expect(envFile()).toContain(`IRIS_IMAGE=${refs.v2}\nPORTAL_IMAGE=${refs.v1}\n`);
    expect(fs.readFileSync(path.join(dir, 'deploy-state', 'previous'), 'utf8')).toBe(
      `IRIS_IMAGE=${refs.v2}\nPORTAL_IMAGE=${refs.v1}\n`,
    );
  }, 120_000);
});
