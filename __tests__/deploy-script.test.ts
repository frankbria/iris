/**
 * deploy/deploy.sh (#273) against the local Docker.
 *
 * Test strategy: a throwaway registry on a loopback port, so the script deploys real
 * `@sha256:` digest refs and really pulls them. The images are busybox builds that
 * model only what the script depends on: a migration that exits 0 or 1
 * (`dist/db/migrate.js`), an SMTP check that passes only when the release's mounted
 * `smtp_url` secret says `ok`, healthchecks that pass or fail, and a worker that
 * writes a heartbeat checked by the production compose file's own command. Their
 * `node` is a shell wrapper, so those "scripts" are shell.
 *
 * Each case stages a release directory the way the deploy job does
 * (<root>/releases/<id>/ with its compose file, settings.env and secrets/, shared
 * secrets in <root>/shared/secrets) and runs the script from it. The cases share one
 * registry and one compose project, and run in order: each starts from the state the
 * previous one left.
 *
 * Docker is required under CI and skipped (with a warning) locally without it.
 */

import { execFileSync, spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'deploy', 'deploy.sh');
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

/** The production worker healthcheck, with a 3s threshold instead of 180s. */
const WORKER_CHECK = (() => {
  const m = fs
    .readFileSync(path.join(ROOT, 'docker-compose.production.yml'), 'utf8')
    .match(/'(test \$\$\(\( .*iris-worker-heartbeat\) \)\) -lt )180'/);
  if (!m) throw new Error('worker healthcheck not found in docker-compose.production.yml');
  return `${m[1]}3`;
})();

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
    retries: 1
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
    environment:
      MARK: \${MARK:?}
    secrets: [shared]
  worker:
    <<: *app
    image: \${IRIS_IMAGE:?}
    command: ['sh', '/app/worker.sh']
    healthcheck:
      test: ['CMD-SHELL', '${WORKER_CHECK}']
      interval: 1s
      timeout: 2s
      retries: 2
  portal:
    <<: *app
    image: \${PORTAL_IMAGE:?}
    secrets: [smtp_url]
secrets:
  smtp_url:
    file: ./secrets/smtp_url
  shared:
    file: ../../shared/secrets/shared
`;

(DOCKER ? describe : describe.skip)('deploy/deploy.sh', () => {
  const registry = `iris-deploy-test-registry-${process.pid}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-deploy-'));
  const root = path.join(dir, 'box');
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
    put(
      'app/verify/apps/portal/scripts/verify-smtp.js',
      '[ "$(cat /run/secrets/smtp_url)" = ok ]\n',
    );
    put('app/health', `${health}\n`);
    put(
      'app/worker.sh',
      'while :; do [ "$(cat /app/health)" = 0 ] && touch /tmp/iris-worker-heartbeat; sleep 1; done\n',
    );
    put('app/version', `${name}\n`);
    put('Dockerfile', `FROM ${BASE}\nCOPY node /bin/node\nCOPY app /app\nWORKDIR /app\n`);
    const tag = `${repo}:${name}`;
    docker('build', '-q', '-t', tag, ctx);
    docker('push', '-q', tag);
    const digest = docker('inspect', '-f', '{{index .RepoDigests 0}}', tag);
    docker('rmi', tag); // the deploy must pull it by digest
    return digest;
  }

  /** A release directory as the deploy job stages it. */
  function stage(id: string, { smtp = 'ok', mark = 'a', db = refs.db } = {}): string {
    const release = path.join(root, 'releases', id);
    fs.mkdirSync(path.join(release, 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(release, 'docker-compose.yml'), COMPOSE);
    fs.writeFileSync(path.join(release, 'settings.env'), `DB_IMAGE=${db}\nMARK=${mark}\n`);
    fs.writeFileSync(path.join(release, 'secrets', 'smtp_url'), smtp);
    return release;
  }

  function deploy(release: string, iris: string, portal: string) {
    const r = spawnSync('bash', [SCRIPT], {
      cwd: release,
      encoding: 'utf8',
      env: {
        ...process.env,
        IRIS_IMAGE: iris,
        PORTAL_IMAGE: portal,
        DEPLOY_WAIT_TIMEOUT: '30',
        DEPLOY_KEEP_RELEASES: '2',
      },
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  }

  const current = () => {
    try {
      return fs.realpathSync(path.join(root, 'current'));
    } catch {
      return null;
    }
  };

  /** service -> what its container runs: image ref, id, MARK, and bind mount sources. */
  function running() {
    const out: Record<string, { image: string; id: string; mark: string; mounts: string }> = {};
    for (const service of ['iris', 'worker', 'portal']) {
      const id = docker(
        'ps',
        '-q',
        '--filter',
        'label=com.docker.compose.project=iris-deploy-test',
        '--filter',
        `label=com.docker.compose.service=${service}`,
      );
      const [image, mark, mounts] = id
        ? docker(
            'inspect',
            '-f',
            '{{.Config.Image}}|{{range .Config.Env}}{{.}} {{end}}|{{range .Mounts}}{{.Source}} {{end}}',
            id,
          ).split('|')
        : ['', '', ''];
      out[service] = { image, id, mark: /MARK=(\S+)/.exec(mark)?.[1] ?? '', mounts };
    }
    return out;
  }

  /** Every file under a release directory, by relative path. */
  function snapshot(release: string): Record<string, string> {
    const files: Record<string, string> = {};
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else files[path.relative(release, p)] = fs.readFileSync(p, 'utf8');
      }
    };
    walk(release);
    return files;
  }

  const down = () =>
    spawnSync('docker', [
      'compose',
      '-p',
      'iris-deploy-test',
      'down',
      '-v',
      '--remove-orphans',
      '-t',
      '1',
    ]);

  beforeAll(() => {
    docker('pull', '-q', BASE);
    docker('run', '-d', '--name', registry, '-p', '127.0.0.1::5000', 'registry:2');
    const port = docker('port', registry, '5000/tcp').split(':').pop();
    repo = `127.0.0.1:${port}/iris-deploy-test`;
    fs.mkdirSync(path.join(root, 'shared', 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'shared', 'secrets', 'shared'), 'shared');
    refs.db = image('db');
    refs.db2 = image('db2');
    refs.v1 = image('v1');
    refs.v2 = image('v2');
    refs.badMigration = image('bad-migration', { migrate: 1 });
    refs.unhealthy = image('unhealthy', { health: 1 });
  }, 180_000);

  afterAll(() => {
    down();
    spawnSync('docker', ['rm', '-f', '-v', registry]);
    for (const ref of Object.values(refs)) spawnSync('docker', ['rmi', ref]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('first deploy of an unhealthy release: fails, with nothing to roll back to', () => {
    const r = deploy(stage('r0'), refs.unhealthy, refs.unhealthy);
    expect(r.out).toMatch(/no previous release to roll back to/);
    expect(r.status).toBe(1);
    expect(current()).toBeNull();
    down();
  }, 90_000);

  it('deploys by digest; a second release of the same digests succeeds; old releases are pruned', () => {
    for (const id of ['r1', 'r2']) {
      const release = stage(id);
      const r = deploy(release, refs.v2, refs.v1);
      expect(r.out).toMatch(/healthy/);
      expect(r.status).toBe(0);
      expect(current()).toBe(fs.realpathSync(release));
      const now = running();
      expect([now.iris.image, now.worker.image, now.portal.image]).toEqual([
        refs.v2,
        refs.v2,
        refs.v1,
      ]);
      // Bind mounts name this release's own files, not `current`.
      expect(now.portal.mounts).toContain(
        path.join(fs.realpathSync(release), 'secrets', 'smtp_url'),
      );
    }
    // DEPLOY_KEEP_RELEASES=2: the failed r0 is gone.
    expect(fs.readdirSync(path.join(root, 'releases')).sort()).toEqual(['r1', 'r2']);
  }, 150_000);

  /** Runs a release that must fail before the switch, and checks nothing changed. */
  function expectUntouched(
    id: string,
    iris: string,
    portal: string,
    opts: { smtp?: string },
    why: RegExp,
  ) {
    const serving = current()!;
    const before = { files: snapshot(serving), running: running() };
    const r = deploy(stage(id, { ...opts, mark: 'new' }), iris, portal);
    expect(r.out).toMatch(why);
    expect(r.status).not.toBe(0);
    expect(current()).toBe(serving);
    expect(snapshot(serving)).toEqual(before.files);
    expect(running()).toEqual(before.running);
  }

  it('a failing SMTP check changes nothing: same release, same files, same containers', () => {
    expectUntouched('r3', refs.v1, refs.v1, { smtp: 'bad' }, /SMTP check failed/);
  }, 90_000);

  it('a failed pull changes nothing', () => {
    expectUntouched('r4', `${repo}@sha256:${'0'.repeat(64)}`, refs.v1, {}, /./);
  }, 90_000);

  it('a failed migration changes nothing', () => {
    expectUntouched('r5', refs.badMigration, refs.badMigration, {}, /migration failed/);
  }, 90_000);

  // A deploy cut off mid-way (job cancelled, host rebooted) must leave `current` on the
  // last release that became healthy: the next deploy rolls back to it.
  it('an interrupted deploy leaves current on the last healthy release', async () => {
    const serving = current()!;
    const release = stage('r5i', { mark: 'b' });
    const child = spawn('bash', [SCRIPT], {
      cwd: release,
      env: {
        ...process.env,
        IRIS_IMAGE: refs.unhealthy,
        PORTAL_IMAGE: refs.unhealthy,
        DEPLOY_WAIT_TIMEOUT: '30',
        DEPLOY_KEEP_RELEASES: '2',
      },
      stdio: 'ignore',
      detached: true,
    });
    const exited = new Promise((resolve) => child.on('exit', resolve));
    // Wait until the new containers exist (running or already exited): the script is
    // then in its health wait.
    const created = () =>
      docker(
        'ps',
        '-aq',
        '--filter',
        'label=com.docker.compose.project=iris-deploy-test',
        '--filter',
        'label=com.docker.compose.service=iris',
        // Not the migration's `compose run` container: the service's own.
        '--filter',
        'label=com.docker.compose.oneoff=False',
        '--filter',
        `ancestor=${refs.unhealthy}`,
      );
    for (let i = 0; i < 120 && !created(); i++) {
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(created()).not.toBe('');
    process.kill(-child.pid!, 'SIGKILL');
    await exited;
    expect(current()).toBe(serving);
    // The next deploy of a good release puts things right (and needs the serving one back).
    const r = deploy(stage('r5j'), refs.v2, refs.v1);
    expect(r.status).toBe(0);
    fs.rmSync(path.join(root, 'releases', 'r5i'), { recursive: true, force: true });
  }, 150_000);

  it('an unhealthy release rolls back to the previous release: its images, settings and files', () => {
    const serving = current()!;
    const r = deploy(stage('r6', { mark: 'b' }), refs.unhealthy, refs.unhealthy);
    expect(r.out).toMatch(/rolled back/);
    expect(r.status).toBe(1);
    expect(current()).toBe(serving);
    const now = running();
    expect([now.iris.image, now.worker.image, now.portal.image]).toEqual([
      refs.v2,
      refs.v2,
      refs.v1,
    ]);
    expect(now.iris.mark).toBe('a'); // the previous release's settings, not r6's
    expect(now.portal.mounts).toContain(path.join(serving, 'secrets', 'smtp_url'));
  }, 150_000);
  // A bumped Postgres digest (a security release) must reach the running database;
  // an unchanged one must leave it alone (#273 review).
  it('recreates postgres only when its image changed', () => {
    const pg = () =>
      docker(
        'ps',
        '-q',
        '--filter',
        'label=com.docker.compose.project=iris-deploy-test',
        '--filter',
        'label=com.docker.compose.service=postgres',
      );
    const before = pg();
    expect(deploy(stage('r7'), refs.v2, refs.v1).status).toBe(0);
    expect(pg()).toBe(before);
    expect(deploy(stage('r8', { db: refs.db2 }), refs.v2, refs.v1).status).toBe(0);
    expect(pg()).not.toBe(before);
    expect(docker('inspect', '-f', '{{.Config.Image}}', pg())).toBe(refs.db2);
  }, 150_000);
});
