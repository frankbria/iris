/**
 * Hosted `iris connect` authenticates org API keys (#341, ADR 0001 §4).
 *
 * Test strategy: real Postgres and a real `iris connect` child with IRIS_HOSTED=1
 * (the switch is read once per process, and BetterAuth is ESM-only, which Jest's
 * sandbox cannot load). A spawned probe signs up two users, so BetterAuth gives each
 * an org, and creates keys through the plugin, as the portal does. The tests then
 * connect over a real socket with those keys. The protocol half (re-check timer,
 * pending upgrades, 503) is in `protocol-auth.test.ts`.
 *
 * The startup refusals need no database and always run.
 */

import { execFile, spawn, ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import { once } from 'events';
import * as net from 'net';
import * as path from 'path';
import { promisify } from 'util';
import { Client } from 'pg';
import WebSocket from 'ws';
import { JsonRpcResponse } from '../src/protocol';
import { createPostgresDb } from '../src/db/postgres';
import { migrateToLatest } from '../src/db/migrate';

const ADMIN_URL = process.env.IRIS_TEST_DATABASE_URL;
const REPO_ROOT = path.resolve(__dirname, '..');
const SECRET = randomBytes(32).toString('hex');
const HOSTED_ENV = {
  TS_NODE_TRANSPILE_ONLY: '1',
  BETTER_AUTH_TELEMETRY: '0',
  IRIS_HOSTED: '1',
  BETTER_AUTH_SECRET: SECRET,
  BETTER_AUTH_URL: 'https://portal.example.com',
};

if (!ADMIN_URL) {
  if (process.env.CI) throw new Error('IRIS_TEST_DATABASE_URL is required in CI');
  console.warn(
    'Skipping API key auth tests: set IRIS_TEST_DATABASE_URL (see docker-compose.dev.yml)',
  );
}

async function freePort(): Promise<number> {
  const srv = net.createServer().listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const { port } = srv.address() as net.AddressInfo;
  await new Promise((r) => srv.close(r));
  return port;
}

interface Connect {
  proc: ChildProcess;
  out: string;
  exit: Promise<number | null>;
}

function spawnConnect(port: number, env: NodeJS.ProcessEnv): Connect {
  const proc = spawn(
    process.execPath,
    ['-r', 'ts-node/register', path.join(REPO_ROOT, 'src/cli.ts'), 'connect', String(port)],
    { cwd: REPO_ROOT, env: { ...process.env, ...env } },
  );
  const c: Connect = {
    proc,
    out: '',
    exit: new Promise((resolve) => proc.on('exit', (code) => resolve(code))),
  };
  proc.stdout!.on('data', (d) => (c.out += d));
  proc.stderr!.on('data', (d) => (c.out += d));
  return c;
}

/**
 * The exit code, or `'still running'` after `ms`. A server that should have refused
 * to start is killed rather than left listening, which would also keep Jest alive.
 */
async function exitCode(c: Connect, ms = 30_000): Promise<number | null | 'still running'> {
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    c.exit,
    new Promise<'still running'>((r) => (timer = setTimeout(() => r('still running'), ms))),
  ]);
  clearTimeout(timer);
  if (result === 'still running') c.proc.kill('SIGKILL');
  return result;
}

describe('hosted iris connect refuses to start without key authentication', () => {
  test('a shared token in hosted mode is refused, not silently ignored', async () => {
    const c = spawnConnect(await freePort(), {
      ...HOSTED_ENV,
      DATABASE_URL: 'postgres://unused',
      IRIS_CONNECT_TOKEN: 'shared',
    });
    expect(await exitCode(c)).toBe(2);
    expect(c.out).toMatch(/Hosted mode authenticates API keys/);
  }, 40_000);

  test.each([
    ['BETTER_AUTH_SECRET', /BETTER_AUTH_SECRET/],
    ['BETTER_AUTH_URL', /BETTER_AUTH_URL/],
    ['DATABASE_URL', /DATABASE_URL/],
  ])(
    'missing %s exits 3 and names it',
    async (name, message) => {
      const env: NodeJS.ProcessEnv = { ...HOSTED_ENV, DATABASE_URL: 'postgres://unused' };
      delete env[name];
      const c = spawnConnect(await freePort(), env);
      expect(await exitCode(c)).toBe(3);
      expect(c.out).toMatch(message);
      expect(c.out).not.toMatch(/listening/);
    },
    40_000,
  );
});

// Signs up alice and bob (each gets an org at sign-in), creates keys through the
// plugin, and checks the authenticator against a live and a closed pool.
const PROBE = `
const { Pool } = require('pg');
const { createAuth } = require('./src/auth/config.ts');
const { apiKeyAuthenticator } = require('./src/api-key-auth.ts');
const PASSWORD = 'correct-horse-battery-staple';
(async () => {
  const pool = new Pool({ connectionString: process.env.PROBE_URL });
  const auth = createAuth({
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: process.env.BETTER_AUTH_URL,
    database: pool,
    sendEmail: async () => {},
  });
  const user = async (name) => {
    const email = name + '@iris.test';
    await auth.api.signUpEmail({ body: { email, password: PASSWORD, name } });
    await pool.query('update "user" set "emailVerified" = true where email = $1', [email]);
    const res = await auth.api.signInEmail({ body: { email, password: PASSWORD }, returnHeaders: true });
    const headers = new Headers({ cookie: res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') });
    const org = (await auth.api.getSession({ headers })).session.activeOrganizationId;
    return { headers, org };
  };
  const key = async (u, name) =>
    auth.api.createApiKey({ headers: u.headers, body: { organizationId: u.org, name } });
  const alice = await user('alice');
  const bob = await user('bob');
  const r = { A: alice.org, B: bob.org };
  for (const [k, owner] of [['a', alice], ['b', bob], ['revoked', alice], ['disabled', bob]]) {
    const created = await key(owner, k);
    r[k] = { key: created.key, id: created.id };
  }
  await auth.api.deleteApiKey({ headers: alice.headers, body: { keyId: r.revoked.id } });
  await auth.api.updateApiKey({ headers: bob.headers, body: { keyId: r.disabled.id, enabled: false } });

  // The authenticator itself: a verdict while the database answers, an error when it cannot.
  const authn = apiKeyAuthenticator(auth, () => pool.query('select 1'));
  r.live = await authn('Bearer ' + r.a.key);
  r.unknown = await authn('Bearer iris_nope');
  r.notBearer = await authn('Basic ' + r.a.key);
  await pool.end();
  r.down = await authn('Bearer iris_nope').then((v) => ({ value: v }), (e) => ({ threw: String(e.message) }));
  process.stdout.write(JSON.stringify(r));
})().catch((e) => { console.error(e); process.exit(1); });
`;

(ADMIN_URL ? describe : describe.skip)('hosted iris connect with real API keys', () => {
  const dbName = `iris_keyauth_${process.pid}_${randomBytes(4).toString('hex')}`;
  let dbUrl: string;
  let r: any;
  let server: Connect;
  let port: number;
  const sockets: WebSocket[] = [];

  async function admin(query: string): Promise<void> {
    const client = new Client({ connectionString: ADMIN_URL });
    await client.connect();
    try {
      await client.query(query);
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    await admin(`CREATE DATABASE "${dbName}"`);
    const u = new URL(ADMIN_URL!);
    u.pathname = `/${dbName}`;
    dbUrl = u.toString();
    const db = createPostgresDb(dbUrl);
    try {
      await migrateToLatest(db);
    } finally {
      await db.destroy();
    }
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['-r', 'ts-node/register', '-e', PROBE],
      { cwd: REPO_ROOT, env: { ...process.env, ...HOSTED_ENV, PROBE_URL: dbUrl } },
    );
    r = JSON.parse(stdout);
    port = await freePort();
    server = spawnConnect(port, { ...HOSTED_ENV, DATABASE_URL: dbUrl });
    const deadline = Date.now() + 30_000;
    while (!server.out.includes('listening')) {
      if (Date.now() > deadline) throw new Error(`connect never listened:\n${server.out}`);
      await new Promise((res) => setTimeout(res, 50));
    }
  }, 90_000);

  afterAll(async () => {
    for (const ws of sockets) ws.terminate();
    if (server) {
      server.proc.kill('SIGTERM');
      await server.exit;
    }
    await admin(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  }, 30_000);

  function open(authorization?: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: authorization ? { authorization } : {},
      });
      sockets.push(ws);
      ws.once('open', () => resolve(ws));
      ws.once('unexpected-response', (_req, res) => {
        reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode }));
        ws.terminate();
      });
      ws.once('error', reject);
    });
  }

  const statusOf = (p: Promise<unknown>) =>
    p.then(
      () => undefined,
      (e) => (e as { status?: number }).status,
    );

  let nextId = 1;
  function call(ws: WebSocket, method: string): Promise<JsonRpcResponse> {
    const id = nextId++;
    return new Promise((resolve) => {
      const onMessage = (data: WebSocket.Data) => {
        const res = JSON.parse(data.toString()) as JsonRpcResponse;
        if (res.id !== id) return;
        ws.off('message', onMessage);
        resolve(res);
      };
      ws.on('message', onMessage);
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method }));
    });
  }

  test('the authenticator maps a key to its org, and refuses only when the database answered', () => {
    expect(r.live).toEqual({ orgId: r.A, keyId: r.a.id });
    expect(r.unknown).toBeNull();
    expect(r.notBearer).toBeNull();
    // A closed pool is "cannot tell", never "invalid key".
    expect(r.down).toHaveProperty('threw');
  });

  test('a live key opens a connection; no key, a wrong key, a revoked and a disabled key get 401', async () => {
    const ws = await open(`Bearer ${r.a.key}`);
    expect((await call(ws, 'getStatus')).result.status).toBe('ready');
    expect(await statusOf(open())).toBe(401);
    expect(await statusOf(open('Bearer iris_notakey'))).toBe(401);
    expect(await statusOf(open(`Bearer ${r.revoked.key}`))).toBe(401);
    expect(await statusOf(open(`Bearer ${r.disabled.key}`))).toBe(401);
    // The key as a raw header, without the scheme, is not accepted either.
    expect(await statusOf(open(r.a.key))).toBe(401);
  });

  test("each connection acts for its key's org", async () => {
    const a = await open(`Bearer ${r.a.key}`);
    const b = await open(`Bearer ${r.b.key}`);
    expect((await call(a, 'launchBrowser')).result.success).toBe(true);
    expect((await call(a, 'getStatus')).result.activeSessions).toBe(1);
    expect((await call(b, 'getStatus')).result.activeSessions).toBe(0);
  });

  test('no shared token is printed in hosted mode', () => {
    expect(server.out).not.toMatch(/Auth token/);
  });
});
