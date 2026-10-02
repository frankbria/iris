import { spawn } from 'child_process';
import { once } from 'events';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import WebSocket, { type WebSocketServer } from 'ws';
import { startServer } from '../src/protocol';

/**
 * The container's runtime hardening (issue #332) lives in config files no test
 * executes, so a later edit could quietly drop any line of it and every suite
 * would stay green. These assertions pin each setting; the behaviour itself is
 * proven by the staging deploy probe, which launches a sandboxed Chromium
 * inside the real container.
 */

const ROOT = path.resolve(__dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/** The compose file with comment lines removed, so prose cannot satisfy a check. */
const compose = read('docker-compose.staging.yml')
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

describe('docker-compose.staging.yml hardening (issue #332)', () => {
  it('reaps Chromium children with an init process as PID 1', () => {
    expect(compose).toMatch(/^\s+init: true$/m);
  });

  it('drops every capability and forbids privilege gain', () => {
    expect(compose).toMatch(/^\s+cap_drop:\n\s+- ALL$/m);
    expect(compose).toMatch(/^\s+- no-new-privileges:true$/m);
  });

  it('runs Chromium sandboxed: a seccomp profile, and no opt-out', () => {
    expect(compose).toMatch(/^\s+- seccomp=\.\/docker\/seccomp-chromium\.json$/m);
    expect(compose).not.toMatch(/IRIS_CHROMIUM_SANDBOX/);
  });

  it('mounts the root filesystem read-only with tmpfs for what Chromium writes', () => {
    expect(compose).toMatch(/^\s+read_only: true$/m);
    expect(compose).toMatch(/^\s+- \/tmp:/m);
    expect(compose).toMatch(/^\s+- \/home\/pwuser:/m);
  });

  it('bounds memory, CPU and process count', () => {
    expect(compose).toMatch(/^\s+mem_limit: \d+[mg]$/m);
    expect(compose).toMatch(/^\s+cpus: '?[\d.]+'?$/m);
    expect(compose).toMatch(/^\s+pids_limit: [1-9]\d*$/m);
  });

  it('gives shutdown longer than the server takes to force-exit (5s, src/cli.ts)', () => {
    const grace = compose.match(/^\s+stop_grace_period: (\d+)s$/m);
    expect(grace).not.toBeNull();
    expect(Number(grace![1])).toBeGreaterThan(5);
  });

  it('delivers the token as a secret file, never as an environment variable', () => {
    expect(compose).not.toMatch(/^\s+IRIS_CONNECT_TOKEN:/m);
    expect(compose).toMatch(/^\s+IRIS_CONNECT_TOKEN_FILE: \/run\/secrets\/connect_token$/m);
    expect(compose).toMatch(/^secrets:\n\s+connect_token:\n\s+file: \.\/secrets\/connect_token$/m);
  });
});

describe('docker/seccomp-chromium.json (issue #332)', () => {
  interface Rule {
    names: string[];
    action: string;
    errnoRet?: number;
    args?: unknown[];
    includes?: { caps?: string[] };
    excludes?: { caps?: string[] };
  }
  const profile = JSON.parse(read('docker/seccomp-chromium.json')) as {
    defaultAction: string;
    syscalls: Rule[];
  };

  it('denies by default, like Docker’s own profile', () => {
    expect(profile.defaultAction).toBe('SCMP_ACT_ERRNO');
  });

  it('allows the sandbox syscalls (user namespace, chroot) without capabilities', () => {
    const unconditional = profile.syscalls.filter(
      (r) => r.action === 'SCMP_ACT_ALLOW' && !r.args?.length && !r.includes?.caps,
    );
    for (const name of ['chroot', 'clone', 'setns', 'unshare']) {
      expect(unconditional.some((r) => r.names.includes(name))).toBe(true);
    }
  });

  // An older profile (Playwright's, 2021) has no clone3 rule, so clone3 hits the
  // default EPERM — and glibc falls back to clone only on ENOSYS, so creating a
  // thread fails outright.
  it('answers clone3 with ENOSYS so glibc falls back to clone', () => {
    const clone3 = profile.syscalls.find((r) => r.names.includes('clone3') && r.errnoRet);
    expect(clone3).toMatchObject({ action: 'SCMP_ACT_ERRNO', errnoRet: 38 });
  });
});

describe('Dockerfile and deploy wiring (issue #332)', () => {
  it('runs the image as the unprivileged pwuser', () => {
    const users = read('Dockerfile').match(/^USER \S+$/gm);
    expect(users?.at(-1)).toBe('USER pwuser');
  });

  // Docker seeds a new named volume from the image's mount point, owner
  // included. Without this /data is root-owned and pwuser cannot create the
  // history database at IRIS_DB_PATH — found while hardening in #332.
  it('hands the /data volume mount point to pwuser', () => {
    expect(read('Dockerfile')).toMatch(/^RUN install -d -o pwuser -g pwuser \/data$/m);
  });

  // History, the cost ledger and the vision cache all resolve from here (#241).
  // The root filesystem is read-only, so anything left cwd-relative under /app
  // would fail with EROFS; the volume is the only durable writable place.
  it('points the data dir at the /data volume', () => {
    expect(read('docker-compose.staging.yml')).toMatch(/^\s+IRIS_DATA_DIR: \/data$/m);
  });

  it('ships the seccomp profile and the token file to the host, and not the token in .env', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toMatch(/docker\/seccomp-chromium\.json/);
    expect(ci).toMatch(/\/opt\/iris\/secrets\/connect_token/);
    expect(ci).not.toMatch(/IRIS_CONNECT_TOKEN=%s/);
    // The token is read once at startup; a rotated file needs a new container.
    expect(ci).toMatch(/docker compose up -d --force-recreate/);
  });
});

describe('staging Postgres and migrations (issue #248)', () => {
  const postgres = compose.slice(compose.indexOf('\n  postgres:'), compose.indexOf('\nvolumes:'));

  it('keeps Postgres off the host: no published port', () => {
    expect(postgres).toMatch(/^\s+image: postgres:/m);
    expect(postgres).not.toMatch(/^\s+ports:/m);
  });

  it('passes the password and the URL as secret files, never as env values', () => {
    expect(postgres).toMatch(/^\s+POSTGRES_PASSWORD_FILE: \/run\/secrets\/pg_password$/m);
    expect(compose).toMatch(/^\s+DATABASE_URL_FILE: \/run\/secrets\/database_url$/m);
    expect(compose).not.toMatch(/^\s+(DATABASE_URL|POSTGRES_PASSWORD):/m);
    expect(compose).toMatch(/^\s+- connect_token\n\s+- database_url$/m);
    expect(compose).toMatch(/depends_on:\n\s+postgres:\n\s+condition: service_healthy$/m);
  });

  it('migrates from the new image after pull and before up, and stops the deploy if it fails', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toMatch(
      /docker compose pull --quiet \\\s+&& docker compose up -d --wait postgres \\\s+&& docker compose run --rm --no-deps --entrypoint node iris dist\/db\/migrate\.js \\\s+&& docker compose up -d --force-recreate --no-deps --remove-orphans iris;/,
    );
    // Generated once on the box: a new password per deploy would not match the
    // one the existing volume was initialised with.
    expect(ci).toMatch(/if \[ ! -s pg_password \]; then/);
  });
});

describe('docker/healthcheck.js reads IRIS_CONNECT_TOKEN_FILE (issue #332)', () => {
  let wss: WebSocketServer;
  let port: number;
  let dir: string;

  beforeEach(async () => {
    wss = startServer(0, { authToken: 'right-token' });
    await once(wss, 'listening');
    port = (wss.address() as net.AddressInfo).port;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-hc-'));
  });

  afterEach(async () => {
    wss.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Spawned, not awaited synchronously: the server runs in this process. */
  async function probe(token: string): Promise<number | null> {
    const file = path.join(dir, 'token');
    fs.writeFileSync(file, `${token}\n`);
    const env = { ...process.env, IRIS_CONNECT_PORT: String(port), IRIS_CONNECT_TOKEN_FILE: file };
    const proc = spawn(process.execPath, [path.join(ROOT, 'docker/healthcheck.js')], {
      env,
      stdio: 'ignore',
    });
    const [code] = (await once(proc, 'exit')) as [number | null];
    return code;
  }

  it('passes with the token from the file', async () => {
    expect(await probe('right-token')).toBe(0);
  });

  it('fails when the file holds the wrong token', async () => {
    expect(await probe('wrong-token')).toBe(1);
  });

  it('passes on a server at --max-connections: busy is not unhealthy (#342)', async () => {
    wss.close();
    wss = startServer(0, { authToken: 'right-token', limits: { maxConnections: 1 } });
    await once(wss, 'listening');
    port = (wss.address() as net.AddressInfo).port;
    const client = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { authorization: 'Bearer right-token' },
    });
    await once(client, 'open');
    try {
      expect(await probe('right-token')).toBe(0);
    } finally {
      client.terminate();
    }
  });
});

describe('docker-compose.production.yml (issue #273)', () => {
  const file = read('docker-compose.production.yml')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  /** One service's block: from `  name:` to the next two-space key or top-level key. */
  const service = (name: string) => {
    const m = file.match(new RegExp(`^  ${name}:\\n((?:(?:    .*)?\\n)*)`, 'm'));
    expect(m).not.toBeNull();
    return m![1];
  };

  it('runs postgres, hosted iris-api, the worker and the portal', () => {
    expect(service('iris')).toMatch(/^\s+command: \['connect', '4000'\]$/m);
    expect(service('iris')).toMatch(/^\s+IRIS_HOSTED: '1'$/m);
    expect(service('worker')).toMatch(/^\s+command: \['worker'\]$/m);
    expect(service('worker')).toMatch(/^\s+IRIS_HOSTED: '1'$/m);
    expect(service('portal')).toBeTruthy();
    expect(service('postgres')).toMatch(/^\s+image: postgres:17-alpine@sha256:[0-9a-f]{64}$/m);
  });

  it('pins every image by digest: a literal @sha256 or a required digest env var', () => {
    const images = [...file.matchAll(/^\s+image: (.*)$/gm)].map((m) => m[1]);
    expect(images).toHaveLength(4);
    for (const image of images) {
      expect(image).toMatch(
        /^(?:[^\s$]+@sha256:[0-9a-f]{64}|\$\{(?:IRIS|PORTAL)_IMAGE:\?[^}]*\})$/,
      );
    }
  });

  it('gives the worker a heartbeat liveness check its loop feeds (src/worker.ts)', () => {
    const s = service('worker');
    expect(s).toMatch(/^\s+IRIS_WORKER_HEARTBEAT_FILE: \/tmp\/iris-worker-heartbeat$/m);
    expect(s).toMatch(/stat -c %Y \/tmp\/iris-worker-heartbeat\) \)\) -lt 180/);
  });

  it('takes every app image from a required env var, never a tag in the file', () => {
    expect(service('iris')).toMatch(/^\s+image: \$\{IRIS_IMAGE:\?[^}]*\}$/m);
    expect(service('worker')).toMatch(/^\s+image: \$\{IRIS_IMAGE:\?[^}]*\}$/m);
    expect(service('portal')).toMatch(/^\s+image: \$\{PORTAL_IMAGE:\?[^}]*\}$/m);
    expect(file).not.toMatch(/ghcr\.io/);
  });

  it.each(['iris', 'worker'])('hardens %s like staging (#332)', (name) => {
    const s = service(name);
    expect(s).toMatch(/^\s+init: true$/m);
    expect(s).toMatch(/^\s+cap_drop:\n\s+- ALL$/m);
    expect(s).toMatch(/^\s+- no-new-privileges:true$/m);
    expect(s).toMatch(/^\s+- seccomp=\.\/docker\/seccomp-chromium\.json$/m);
    expect(s).toMatch(/^\s+read_only: true$/m);
    expect(s).toMatch(/^\s+- \/tmp:/m);
    expect(s).toMatch(/^\s+- \/home\/pwuser:/m);
    expect(s).toMatch(/^\s+shm_size: 1gb$/m);
    expect(s).toMatch(/^\s+mem_limit: \d+[mg]$/m);
    expect(s).toMatch(/^\s+cpus: '?[\d.]+'?$/m);
    expect(s).toMatch(/^\s+pids_limit: [1-9]\d*$/m);
    expect(Number(s.match(/^\s+stop_grace_period: (\d+)s$/m)?.[1])).toBeGreaterThan(5);
    expect(s).not.toMatch(/IRIS_CHROMIUM_SANDBOX/);
  });

  it('hardens the portal: read-only, no capabilities, no privilege gain, limits', () => {
    const s = service('portal');
    expect(s).toMatch(/^\s+read_only: true$/m);
    expect(s).toMatch(/^\s+cap_drop:\n\s+- ALL$/m);
    expect(s).toMatch(/^\s+- no-new-privileges:true$/m);
    expect(s).toMatch(/^\s+mem_limit: \d+[mg]$/m);
    expect(s).toMatch(/^\s+pids_limit: [1-9]\d*$/m);
  });

  it('publishes iris-api and the portal on loopback only, at the ingress ports (#347)', () => {
    const ports = [...file.matchAll(/^\s+- '([^']*:\d+)'$/gm)].map((m) => m[1]);
    expect(ports).toEqual([
      '127.0.0.1:${IRIS_API_PORT:-4000}:4000',
      '127.0.0.1:${PORTAL_PORT:-3000}:3000',
    ]);
    expect(service('postgres')).not.toMatch(/ports:/);
    expect(service('worker')).not.toMatch(/ports:/);
    const nginx = read('deploy/nginx/iris.conf');
    expect(nginx).toMatch(/127\.0\.0\.1:4000/);
    expect(nginx).toMatch(/127\.0\.0\.1:3000/);
  });

  it('passes every secret as a file, never as an environment value', () => {
    for (const name of [
      'BETTER_AUTH_SECRET',
      'SMTP_URL',
      'DATABASE_URL',
      'IRIS_KEY_ENCRYPTION_KEY',
    ]) {
      expect(file).not.toMatch(new RegExp(`^\\s+${name}:`, 'm'));
    }
    expect(file).not.toMatch(/IRIS_CONNECT_TOKEN/);
    // Per release (deploy.sh stages each release in its own directory) ...
    for (const secret of ['better_auth_secret', 'smtp_url']) {
      expect(file).toMatch(new RegExp(`^  ${secret}:\\n\\s+file: \\./secrets/${secret}$`, 'm'));
    }
    // ... and generated once on the box, shared by every release.
    for (const secret of ['pg_password', 'database_url', 'master_key']) {
      expect(file).toMatch(
        new RegExp(`^  ${secret}:\\n\\s+file: \\.\\./\\.\\./shared/secrets/${secret}$`, 'm'),
      );
    }
  });
});

describe('Dockerfile.portal (issue #273)', () => {
  const dockerfile = read('Dockerfile.portal');

  it('runs the standalone server as uid 1001 on the engines-floor Node line', () => {
    expect(dockerfile).toMatch(/^FROM node:24-alpine AS runtime$/m);
    expect(dockerfile).toMatch(/^USER portal$/m);
    expect(dockerfile).toMatch(/adduser -D -H -u 1001 portal/);
    expect(dockerfile).toMatch(/^CMD \["node", "apps\/portal\/server\.js"\]$/m);
    // Readiness, not liveness: the deploy waits on this (#273).
    expect(dockerfile).toMatch(
      /^\s+CMD \["node", "-e", "fetch\('http:\/\/127\.0\.0\.1:3000\/api\/health'\)/m,
    );
    expect(read('apps/portal/next.config.ts')).toMatch(/output: "standalone"/);
  });

  it('has its own ignore file that keeps credentials out of the context', () => {
    const ignore = read('Dockerfile.portal.dockerignore');
    expect(ignore).toMatch(/^\*\*\/\.env$/m);
    expect(ignore).toMatch(/^secrets$/m);
    expect(ignore).toMatch(/^\*\*\/node_modules$/m);
  });
});
