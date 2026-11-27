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
 * - the image carries no portal packages (`.dockerignore` excludes `apps/`, #394);
 * - its egress firewall (#376) refuses private and metadata addresses from a bridge and
 *   leaves public egress open (host rules on the runner, removed afterwards).
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

  // #360: notices for what ships, and no npm in the runtime image.
  it("ships third-party notices for its production dependencies, and not the portal's", () => {
    const notices = docker(
      'run',
      '--rm',
      '--entrypoint',
      'cat',
      IMAGE!,
      '/app/THIRD_PARTY_NOTICES.txt',
    );
    expect(notices.code).toBe(0);
    expect(notices.out).toMatch(/^playwright@\S+\nLicense: Apache-2\.0$/m);
    expect(notices.out).toMatch(/^ws@\S+\nLicense: MIT$/m);
    expect(notices.out).not.toMatch(/^next@/m);
  });

  it('has no npm', () => {
    const npm = docker(
      'run',
      '--rm',
      '--entrypoint',
      'sh',
      IMAGE!,
      '-c',
      'command -v npm npx || echo none',
    );
    expect(npm.out.trim()).toBe('none');
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

  // #376: the compose `egress` service's script, run as compose runs it, against a bridge
  // of its own. Its host rules are removed afterwards (the service itself never does).
  it('refuses private and metadata addresses from the bridge once the egress firewall runs', () => {
    const net = `iris-egress-${process.pid}`;
    expect(docker('network', 'create', net).code).toBe(0);
    const bridge = `br-${docker('network', 'inspect', '-f', '{{.Id}}', net).out.trim().slice(0, 12)}`;
    const chain = `IRIS-EGRESS-${bridge}`;
    const firewall = (...args: string[]) => [
      '--network',
      'host',
      '--user',
      '0',
      '--cap-drop',
      'ALL',
      '--cap-add',
      'NET_ADMIN',
      '--cap-add',
      'NET_RAW',
      '--entrypoint',
      'bash',
      ...args,
    ];
    const probe = (...target: string[]) =>
      docker(
        'run',
        '--rm',
        '--network',
        net,
        '--cap-drop',
        'ALL',
        '--entrypoint',
        'node',
        '-w',
        '/app',
        IMAGE!,
        'docker/egress-probe.js',
        ...target,
      );
    try {
      // Without the rules nothing refuses: on a cloud runner the metadata service answers.
      expect(probe().out).not.toContain('refused');
      const run = docker(
        'run',
        '-d',
        '--name',
        net,
        '--read-only',
        '--tmpfs',
        '/run',
        '--tmpfs',
        '/tmp',
        '--security-opt',
        'no-new-privileges:true',
        '-e',
        `IRIS_EGRESS_BRIDGE=${bridge}`,
        ...firewall(IMAGE!, '/app/docker/egress-firewall.sh'),
      );
      expect(run.code).toBe(0);
      let applied = false;
      for (let i = 0; i < 30 && !applied; i++) {
        applied = docker('exec', net, 'bash', '/app/docker/egress-firewall.sh', 'check').code === 0;
        if (!applied) spawnSync('sleep', ['1']);
      }
      expect(applied).toBe(true);

      for (const target of [[], ['10.255.255.1', '443'], ['192.168.255.1', '80']]) {
        const refused = probe(...target);
        expect(refused.out).toContain('refused, as the egress firewall does');
        expect(refused.code).toBe(0);
      }
      // Public egress stays open.
      expect(probe('1.1.1.1', '443').out).toContain('accepted a connection');
    } finally {
      docker('rm', '-f', net);
      docker(
        'run',
        '--rm',
        ...firewall(
          IMAGE!,
          '-c',
          `iptables -D DOCKER-USER -i ${bridge} ! -o ${bridge} -j ${chain}; ` +
            `iptables -D INPUT -i ${bridge} -j ${chain}; iptables -F ${chain}; iptables -X ${chain}`,
        ),
      );
      docker('network', 'rm', net);
    }
  }, 180_000);
});
