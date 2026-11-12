/**
 * The portal image (Dockerfile.portal, #273), built beforehand and named by
 * IRIS_TEST_PORTAL_IMAGE (CI's build job builds it). Runs it the way production does:
 * read-only root, no capabilities, every secret from a `_FILE`.
 *
 * - the deploy's SMTP check passes against Mailpit and fails, quickly, against a
 *   closed port (`[::1]`: a closed 127.0.0.1 port blackholes on WSL, #382);
 * - the server serves /login and /api/auth/get-session, signs up (database + mail),
 *   and its readiness route answers 200, or 503 with a bad master key.
 *
 * Required under CI; skipped locally unless IRIS_TEST_PORTAL_IMAGE is set
 * (`docker build -f Dockerfile.portal -t iris-portal:local .` needs BuildKit).
 */

import { execFileSync, spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import { once } from 'events';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { Client } from 'pg';
import { migrateToLatest } from '../src/db/migrate';
import { createPostgresDb } from '../src/db/postgres';
import { ACCEPTED_TERMS } from '../src/legal/versions';
import { closedPort, containerExit, onFreePorts, PortTaken } from './utils/ports';

const IMAGE = process.env.IRIS_TEST_PORTAL_IMAGE;
if (!IMAGE) {
  if (process.env.CI) throw new Error('IRIS_TEST_PORTAL_IMAGE is required in CI');
  console.warn('Skipping portal image tests: IRIS_TEST_PORTAL_IMAGE is not set');
}
const SMTP_URL = process.env.E2E_SMTP_URL ?? 'smtp://127.0.0.1:51025';
const MAILPIT_URL = process.env.E2E_MAILPIT_URL ?? 'http://127.0.0.1:58025';
const ADMIN_URL = process.env.IRIS_TEST_DATABASE_URL;
if (IMAGE && !ADMIN_URL) throw new Error('The portal image test needs IRIS_TEST_DATABASE_URL');

async function admin(query: string): Promise<void> {
  const client = new Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    await client.query(query);
  } finally {
    await client.end();
  }
}

(IMAGE ? describe : describe.skip)('portal image', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-portal-image-'));
  // The whole directory is mounted, so uid 1001 must be able to enter it.
  fs.chmodSync(dir, 0o755);
  const name = `iris-portal-image-test-${process.pid}`;
  const secret = (file: string, value: string) => {
    // World-readable: the container runs as uid 1001, which owns nothing here.
    fs.writeFileSync(path.join(dir, file), value, { mode: 0o644 });
  };
  const run = (env: Record<string, string>, ...cmd: string[]) =>
    spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'host',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges:true',
        '-v',
        `${dir}:/run/secrets:ro`,
        ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
        IMAGE!,
        ...cmd,
      ],
      { encoding: 'utf8', timeout: 60_000 },
    );
  const verify = ['node', 'verify/apps/portal/scripts/verify-smtp.js'];
  const dbName = `iris_portal_image_${process.pid}_${randomBytes(4).toString('hex')}`;
  let databaseUrl = '';

  beforeAll(async () => {
    await admin(`CREATE DATABASE "${dbName}"`);
    const u = new URL(ADMIN_URL!);
    u.pathname = `/${dbName}`;
    databaseUrl = u.toString();
    const db = createPostgresDb(databaseUrl);
    try {
      await migrateToLatest(db);
    } finally {
      await db.destroy();
    }
  });

  afterAll(async () => {
    spawnSync('docker', ['rm', '-f', name, `${name}-bad`, `${name}-taken`]);
    fs.rmSync(dir, { recursive: true, force: true });
    await admin(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  });

  it('SMTP check: ready against a real server, read from SMTP_URL_FILE', () => {
    secret('smtp_url', SMTP_URL);
    const r = run({ SMTP_URL_FILE: '/run/secrets/smtp_url' }, ...verify);
    expect(r.stdout).toMatch(/smtp: ready/);
    expect(r.status).toBe(0);
  });

  it('SMTP check: fails with exit 1 against a closed port', async () => {
    secret('smtp_closed', `smtp://[::1]:${await closedPort('::1')}`);
    const r = run({ SMTP_URL_FILE: '/run/secrets/smtp_closed' }, ...verify);
    expect(r.stderr).toMatch(/smtp: .*ECONNREFUSED/);
    expect(r.status).toBe(1);
  });

  /**
   * Starts the server as production runs it on `port`; resolves with its origin once
   * /login answers 200. Next takes its port from PORT and cannot report one it chose, so
   * the port is probed and can be taken before the server binds it (#666): the container
   * then exits with EADDRINUSE, which is `PortTaken` here. Whoever took the port may
   * accept a connection and never answer, so the container's exit cuts the poll.
   */
  async function serveOn(container: string, masterKeyFile: string, port: number): Promise<string> {
    const base = `http://127.0.0.1:${port}`;
    secret('smtp_url', SMTP_URL);
    secret('auth_secret', 'x'.repeat(64));
    secret('database_url', databaseUrl);
    secret('master_key', `k1:${randomBytes(32).toString('base64')}`);
    secret('master_key_bad', 'not-a-key');
    spawnSync('docker', ['rm', '-f', container]);
    execFileSync('docker', [
      'run',
      '-d',
      '--name',
      container,
      '--network',
      'host',
      '--read-only',
      '--tmpfs',
      '/app/apps/portal/.next/cache:uid=1001,gid=1001',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '-v',
      `${dir}:/run/secrets:ro`,
      '-e',
      `PORT=${port}`,
      '-e',
      `BETTER_AUTH_URL=${base}`,
      '-e',
      'BETTER_AUTH_SECRET_FILE=/run/secrets/auth_secret',
      '-e',
      'DATABASE_URL_FILE=/run/secrets/database_url',
      '-e',
      'SMTP_URL_FILE=/run/secrets/smtp_url',
      '-e',
      'SMTP_FROM=IRIS <no-reply@iris.test>',
      '-e',
      `IRIS_KEY_ENCRYPTION_KEY_FILE=/run/secrets/${masterKeyFile}`,
      IMAGE!,
    ]);
    const exit = containerExit(container);
    try {
      let login = 0;
      for (let i = 0; i < 60 && login !== 200; i++) {
        login = await fetch(`${base}/login`, { signal: exit.signal }).then(
          (r) => r.status,
          () => 0,
        );
        if (exit.signal.aborted) {
          const said = exit.output();
          if (said.includes('EADDRINUSE')) throw new PortTaken(said);
          throw new Error(`the portal container exited:\n${said}`);
        }
        if (login !== 200) await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(login).toBe(200);
      return base;
    } finally {
      exit.stop();
    }
  }

  const serve = (container: string, masterKeyFile: string) =>
    onFreePorts(1, '127.0.0.1', ([port]) => serveOn(container, masterKeyFile, port));

  it('recognises a port something else took, even one that accepts and stays silent (#666)', async () => {
    const accepted: net.Socket[] = [];
    const holder = net.createServer((socket) => accepted.push(socket)).listen(0, '127.0.0.1');
    await once(holder, 'listening');
    const { port } = holder.address() as net.AddressInfo;
    try {
      await expect(serveOn(`${name}-taken`, 'master_key', port)).rejects.toThrow(PortTaken);
    } finally {
      for (const socket of accepted) socket.destroy();
      await new Promise((resolve) => holder.close(resolve));
    }
  }, 60_000);

  it('is ready (/api/health), and signs up through the secret files (database, auth, SMTP)', async () => {
    const base = await serve(name, 'master_key');
    const health = await fetch(`${base}/api/health`);
    expect(health.status).toBe(200);
    const session = await fetch(`${base}/api/auth/get-session`);
    expect(session.status).toBe(200);
    expect(await session.text()).toBe('null');

    // A sign-up writes to the database and mails a verification link.
    const email = `image-${randomBytes(4).toString('hex')}@iris.test`;
    const signUp = await fetch(`${base}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, 'x-real-ip': '192.0.2.7' },
      body: JSON.stringify({
        email,
        password: randomBytes(12).toString('hex'),
        name: 'Image',
        acceptedTerms: ACCEPTED_TERMS,
      }),
    });
    expect(signUp.status).toBe(200);
    let mails = 0;
    for (let i = 0; i < 20 && mails === 0; i++) {
      const res = await fetch(
        `${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
      );
      mails = ((await res.json()) as { messages_count: number }).messages_count;
      if (mails === 0) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(mails).toBe(1);
  }, 60_000);

  it('answers 503, and says nothing more, when the master key does not load', async () => {
    const base = await serve(`${name}-bad`, 'master_key_bad');
    const health = await fetch(`${base}/api/health`);
    expect(health.status).toBe(503);
    expect(await health.text()).toBe('unavailable');
  }, 60_000);
});
