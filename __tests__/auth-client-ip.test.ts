/**
 * BetterAuth's rate limits key on the client IP the ingress vouches for (#347).
 *
 * Test strategy: a real Postgres (a throwaway database) and BetterAuth's HTTP handler,
 * which is where its rate limiter runs (`auth.api.*` calls skip it). The ingress
 * overwrites `X-Real-IP` with the peer address, so each request here plays one client
 * behind it: `X-Real-IP` is what nginx set, `X-Forwarded-For` is whatever the client
 * sent. Sign-in allows 3 attempts per 10s per IP, so the 4th from one IP is a 429.
 * BetterAuth is ESM-only and Jest's sandbox cannot `require(esm)`, so one spawned Node
 * plays every scenario and reports the statuses.
 *
 * The caller also asks for `x-forwarded-for` as its IP header, which `createAuth()`
 * must ignore: without the pin, the rotating header below would get a fresh counter on
 * every request and never see a 429 (the #249 finding).
 *
 * Addresses are documentation ranges (RFC 5737).
 */

import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import * as path from 'path';
import { promisify } from 'util';
import { Client } from 'pg';
import { createPostgresDb } from '../src/db/postgres';
import { migrateToLatest } from '../src/db/migrate';

const ADMIN_URL = process.env.IRIS_TEST_DATABASE_URL;
const REPO_ROOT = path.resolve(__dirname, '..');

if (!ADMIN_URL) {
  if (process.env.CI) throw new Error('IRIS_TEST_DATABASE_URL is required in CI');
  console.warn('Skipping client-IP tests: set IRIS_TEST_DATABASE_URL (see docker-compose.dev.yml)');
}

const PROBE = `
const { Pool } = require('pg');
const { createAuth } = require('./src/auth/config.ts');
const BASE = 'https://portal.example.com';
(async () => {
  const pool = new Pool({ connectionString: process.env.PROBE_URL });
  const auth = createAuth({
    secret: process.env.PROBE_SECRET,
    baseURL: BASE,
    database: pool,
    sendEmail: async () => {},
    // A caller asking for the spoofable header: the pin must win.
    advanced: { ipAddress: { ipAddressHeaders: ['x-forwarded-for'] } },
  });
  const signIn = async (headers) => (await auth.handler(new Request(BASE + '/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE, ...headers },
    body: JSON.stringify({ email: 'nobody@iris.test', password: 'wrong-password-123' }),
  }))).status;
  const r = {};

  // One client (as nginx saw it), rotating X-Forwarded-For on every attempt.
  r.rotatingXff = [];
  for (let i = 1; i <= 4; i++)
    r.rotatingXff.push(await signIn({ 'x-real-ip': '192.0.2.10', 'x-forwarded-for': '198.51.100.' + i }));

  // Other clients have counters of their own, even while that one is blocked.
  r.otherClient = await signIn({ 'x-real-ip': '192.0.2.20', 'x-forwarded-for': '192.0.2.10' });

  // Two hops (client, proxy) in X-Forwarded-For, X-Real-IP = the client: keyed to the
  // client, so a request carrying only X-Real-IP shares its counter...
  r.twoHop = [];
  for (let i = 0; i < 3; i++)
    r.twoHop.push(await signIn({ 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }));
  r.twoHop.push(await signIn({ 'x-real-ip': '203.0.113.7' }));
  // ...and the proxy hop got no counter of its own from it.
  r.proxyHop = await signIn({ 'x-real-ip': '10.0.0.1' });

  await pool.end();
  process.stdout.write(JSON.stringify(r));
})().catch((e) => { console.error(e); process.exit(1); });
`;

(ADMIN_URL ? describe : describe.skip)('BetterAuth client IP behind the ingress', () => {
  const dbName = `iris_ip_${process.pid}_${randomBytes(4).toString('hex')}`;
  let r: any;

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
    const db = createPostgresDb(u.toString());
    try {
      await migrateToLatest(db);
    } finally {
      await db.destroy();
    }
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['-r', 'ts-node/register', '-e', PROBE],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          TS_NODE_TRANSPILE_ONLY: '1',
          BETTER_AUTH_TELEMETRY: '0',
          PROBE_URL: u.toString(),
          PROBE_SECRET: randomBytes(32).toString('hex'),
        },
      },
    );
    r = JSON.parse(stdout);
  }, 60_000);

  afterAll(async () => {
    await admin(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  });

  it('keeps one counter per X-Real-IP however the client rotates X-Forwarded-For', () => {
    expect(r.rotatingXff).toEqual([401, 401, 401, 429]);
  });

  it('gives a different X-Real-IP its own counter', () => {
    expect(r.otherClient).toBe(401);
  });

  it('keys a two-hop X-Forwarded-For to the client, not the proxy', () => {
    expect(r.twoHop).toEqual([401, 401, 401, 429]);
    expect(r.proxyHop).toBe(401);
  });
});
