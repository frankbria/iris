import { spawn } from 'child_process';
import { once } from 'events';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type { WebSocketServer } from 'ws';
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

  it('ships the seccomp profile and the token file to the host, and not the token in .env', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toMatch(/docker\/seccomp-chromium\.json/);
    expect(ci).toMatch(/\/opt\/iris\/secrets\/connect_token/);
    expect(ci).not.toMatch(/IRIS_CONNECT_TOKEN=%s/);
    // The token is read once at startup; a rotated file needs a new container.
    expect(ci).toMatch(/docker compose up -d --force-recreate/);
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
});
