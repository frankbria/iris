/**
 * The iris image, built beforehand and named by IRIS_TEST_IMAGE (CI's build job builds it
 * on every push and PR, #306). Before this, the image was built only by the post-merge
 * staging deploy, so a Dockerfile or base-image break surfaced after merge.
 *
 * Runs it the way staging does, from docker-compose.staging.yml unchanged (copied with the
 * seccomp profile, throwaway secrets and its own Postgres), then checks what #332 and #370
 * found worth proving per PR:
 * - the service reaches `healthy` (an authenticated JSON-RPC round trip);
 * - Chromium launches sandboxed inside it, through `dist/browser.js`, so the seccomp
 *   profile, `cap_drop: ALL` and `read_only` still permit the sandbox;
 * - negative control: the same flags with Docker's default seccomp cannot start the
 *   sandbox, which proves the profile is load-bearing;
 * - the app user can write the /data volume (its ownership regressed silently before);
 * - the image carries no portal packages (`.dockerignore` excludes `apps/`, #394).
 *
 * The compose file names its container `iris-staging` and publishes 127.0.0.1:4000, so
 * both must be free. Required under CI; skipped locally unless IRIS_TEST_IMAGE is set
 * (`DOCKER_BUILDKIT=1 docker build -t iris:local .`).
 */

import { spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const IMAGE = process.env.IRIS_TEST_IMAGE;
if (!IMAGE) {
  if (process.env.CI) throw new Error('IRIS_TEST_IMAGE is required in CI');
  console.warn('Skipping iris image tests: IRIS_TEST_IMAGE is not set');
}

const ROOT = path.resolve(__dirname, '..');
const LAUNCH =
  'require("./dist/browser").launchBrowser().then((b) => b.close()).then(() => console.log("chromium ok"))';

function docker(...args: string[]) {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 300_000 });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

(IMAGE ? describe : describe.skip)('iris image (#306)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-image-'));
  const project = `iris-image-${process.pid}`;
  const tag = `ci-${process.pid}`;
  const compose = (...args: string[]) =>
    spawnSync(
      'docker',
      ['compose', '-p', project, '-f', path.join(dir, 'docker-compose.staging.yml'), ...args],
      { encoding: 'utf8', timeout: 300_000, env: { ...process.env, IRIS_TAG: tag } },
    );

  beforeAll(() => {
    fs.chmodSync(dir, 0o755);
    fs.copyFileSync(
      path.join(ROOT, 'docker-compose.staging.yml'),
      path.join(dir, 'docker-compose.staging.yml'),
    );
    fs.mkdirSync(path.join(dir, 'docker'));
    fs.copyFileSync(
      path.join(ROOT, 'docker/seccomp-chromium.json'),
      path.join(dir, 'docker/seccomp-chromium.json'),
    );
    // Bind-mounted secrets keep the host's owner and mode: the container's uids (1001 for
    // iris, 70 for postgres) own nothing here, so the throwaway values are world-readable.
    fs.mkdirSync(path.join(dir, 'secrets'), { mode: 0o755 });
    const pg = randomBytes(16).toString('hex');
    const secrets: Record<string, string> = {
      connect_token: randomBytes(32).toString('hex'),
      pg_password: pg,
      database_url: `postgres://iris:${pg}@postgres:5432/iris`,
    };
    for (const [name, value] of Object.entries(secrets)) {
      fs.writeFileSync(path.join(dir, 'secrets', name), value, { mode: 0o644 });
    }

    expect(docker('tag', IMAGE!, `ghcr.io/frankbria/iris:${tag}`).code).toBe(0);
    const up = compose('up', '-d', '--wait', '--wait-timeout', '240');
    if (up.status !== 0) {
      const logs = compose('logs', '--no-color', '--tail', '50');
      throw new Error(`compose up failed:\n${up.stdout}${up.stderr}\n${logs.stdout}${logs.stderr}`);
    }
  }, 300_000);

  afterAll(() => {
    compose('down', '-v', '--timeout', '5');
    docker('rmi', `ghcr.io/frankbria/iris:${tag}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  it('becomes healthy under the staging compose file', () => {
    const health = docker('inspect', '-f', '{{.State.Health.Status}}', 'iris-staging');
    expect(health.out.trim()).toBe('healthy');
  });

  it('launches Chromium sandboxed inside the running container', () => {
    const launch = docker('exec', '-w', '/app', 'iris-staging', 'node', '-e', LAUNCH);
    expect(launch.out).toContain('chromium ok');
    expect(launch.code).toBe(0);
  }, 120_000);

  it('cannot start the sandbox under Docker’s default seccomp (the profile is load-bearing)', () => {
    const run = docker(
      'run',
      '--rm',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--read-only',
      '--tmpfs',
      '/tmp:size=512m,mode=1777',
      '--tmpfs',
      '/home/pwuser:size=256m,uid=1001,gid=1001,mode=0700',
      '--shm-size',
      '1g',
      '--entrypoint',
      'node',
      '-w',
      '/app',
      IMAGE!,
      '-e',
      LAUNCH,
    );
    expect(run.out).toContain('Chromium could not start its sandbox');
    expect(run.code).not.toBe(0);
  }, 120_000);

  it('lets the app user write the /data volume', () => {
    expect(docker('exec', 'iris-staging', 'id', '-u').out.trim()).toBe('1001');
    const touch = docker('exec', 'iris-staging', 'touch', '/data/probe');
    expect(touch.out).toBe('');
    expect(touch.code).toBe(0);
  });

  it('carries no portal packages', () => {
    const found = docker(
      'run',
      '--rm',
      '--entrypoint',
      'node',
      '-w',
      '/app',
      IMAGE!,
      '-e',
      'for (const p of ["next", "react", "@hugeicons/react"]) { try { require.resolve(p); console.log("FOUND " + p); } catch {} }',
    );
    expect(found.code).toBe(0);
    expect(found.out).not.toMatch(/FOUND/);
  });
});
