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
import * as http from 'http';
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
import { resolveKeyring } from '../src/byok/crypto';
import { providerKeyStore } from '../src/byok/store';
import { orgSuspensions } from '../src/org-suspension';

const ADMIN_URL = process.env.IRIS_TEST_DATABASE_URL;
const REPO_ROOT = path.resolve(__dirname, '..');
const SECRET = randomBytes(32).toString('hex');
const HOSTED_ENV = {
  TS_NODE_TRANSPILE_ONLY: '1',
  BETTER_AUTH_TELEMETRY: '0',
  IRIS_HOSTED: '1',
  BETTER_AUTH_SECRET: SECRET,
  BETTER_AUTH_URL: 'https://portal.example.com',
  // The BYOK master key (#344): hosted mode refuses to start without one.
  IRIS_KEY_ENCRYPTION_KEY: `k1:${randomBytes(32).toString('base64')}`,
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
    ['IRIS_KEY_ENCRYPTION_KEY', /IRIS_KEY_ENCRYPTION_KEY/],
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

test('a database that never answers exits 3 instead of serving 503s', async () => {
  // Accepts and stays silent: the shape that hangs `pg` without its connect timeout.
  const silent = net.createServer(() => undefined).listen(0, '127.0.0.1');
  await once(silent, 'listening');
  const { port: dbPort } = silent.address() as net.AddressInfo;
  try {
    const c = spawnConnect(await freePort(), {
      ...HOSTED_ENV,
      DATABASE_URL: `postgres://iris:iris@127.0.0.1:${dbPort}/iris`,
    });
    expect(await exitCode(c)).toBe(3);
    expect(c.out).toMatch(/Cannot reach the database/);
    expect(c.out).not.toMatch(/listening/);
  } finally {
    silent.close();
  }
}, 40_000);

// Signs up alice and bob (each gets an org at sign-in), creates keys through the
// plugin, and checks the authenticator against a live and a closed pool.
const PROBE = `
const { Pool } = require('pg');
const { createAuth } = require('./src/auth/config.ts');
const { apiKeyAuthenticator, postgresKeyStore } = require('./src/api-key-auth.ts');
const { createPostgresDb } = require('./src/db/postgres.ts');
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
    await auth.api.signUpEmail({ body: { email, password: PASSWORD, name, acceptedTerms: require('./src/legal/versions.ts').ACCEPTED_TERMS } });
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

  // The authenticator itself: a verdict only when the key's own row agrees.
  const kdb = createPostgresDb(process.env.PROBE_URL);
  const store = postgresKeyStore(kdb);
  r.usable = {};
  for (const k of ['a', 'revoked', 'disabled']) r.usable[k] = await store.isUsable(r[k].key);
  r.usable.unknown = await store.isUsable('iris_nope');
  // The re-check by id (#342): live only while the key exists, is enabled and is the org's.
  r.live2 = {
    a: await store.isLive({ orgId: r.A, keyId: r.a.id }),
    revoked: await store.isLive({ orgId: r.A, keyId: r.revoked.id }),
    disabled: await store.isLive({ orgId: r.B, keyId: r.disabled.id }),
    otherOrg: await store.isLive({ orgId: r.B, keyId: r.a.id }),
  };
  const lastBefore = (await pool.query('select "lastRequest" from apikey where id = $1', [r.a.id])).rows[0].lastRequest;
  await store.isLive({ orgId: r.A, keyId: r.a.id });
  const lastAfter = (await pool.query('select "lastRequest" from apikey where id = $1', [r.a.id])).rows[0].lastRequest;
  r.recheckWrites = String(lastBefore) !== String(lastAfter);
  // A used-up key with a refill (the plugin refills it on its next verification once
  // the interval has passed) is live only when that refill is due.
  const quota = (lastRefill) => pool.query(
    'update apikey set remaining = 0, "refillAmount" = $2, "refillInterval" = 60000, "lastRefillAt" = $3 where id = $1',
    [r.b.id, lastRefill === undefined ? null : 5, lastRefill ?? null]);
  const liveB = () => store.isLive({ orgId: r.B, keyId: r.b.id });
  await quota(new Date(Date.now() - 3600000));
  r.refill = { due: await liveB() };
  await quota(new Date());
  r.refill.notYet = await liveB();
  await quota(undefined);
  r.refill.none = await liveB();
  await pool.query('update apikey set remaining = null, "refillAmount" = null, "refillInterval" = null where id = $1', [r.b.id]);
  const authn = apiKeyAuthenticator(auth, store);
  r.live = await authn.verify('Bearer ' + r.a.key);
  r.unknown = await authn.verify('Bearer iris_nope');
  r.revokedNow = await authn.verify('Bearer ' + r.revoked.key);
  r.notBearer = await authn.verify('Basic ' + r.a.key);
  // A suspended org (#348): its valid key is 'suspended' at the upgrade and the re-check.
  const { orgSuspensions } = require('./src/org-suspension.ts');
  const susp = orgSuspensions(kdb);
  await susp.suspend(r.B, { reason: 'test', actor: 'probe' });
  r.susp = {
    verify: await authn.verify('Bearer ' + r.b.key),
    recheck: await authn.recheck({ orgId: r.B, keyId: r.b.id }),
    otherOrg: await authn.recheck({ orgId: r.A, keyId: r.a.id }),
    disabledKey: await authn.recheck({ orgId: r.B, keyId: r.disabled.id }),
  };
  await susp.unsuspend(r.B, { reason: 'test', actor: 'probe' });
  r.susp.restored = await authn.verify('Bearer ' + r.b.key);
  const outcome = (p) => p.then((v) => ({ value: v }), (e) => ({ threw: String(e.message) }));
  // BetterAuth's database path fails (its pool is gone) while the key row reads fine:
  // a locked table or a read-only database looks like this to the plugin.
  await pool.end();
  r.brokenVerify = await outcome(authn.verify('Bearer ' + r.a.key));
  r.brokenUnknown = await outcome(authn.verify('Bearer iris_nope'));
  // Nothing answers at all.
  await kdb.destroy();
  r.down = await outcome(authn.verify('Bearer iris_nope'));
  r.downRecheck = await outcome(authn.recheck({ orgId: r.A, keyId: r.a.id }));
  process.stdout.write(JSON.stringify(r));
})().catch((e) => { console.error(e); process.exit(1); });
`;

(ADMIN_URL ? describe : describe.skip)('hosted iris connect with real API keys', () => {
  const dbName = `iris_keyauth_${process.pid}_${randomBytes(4).toString('hex')}`;
  let dbUrl: string;
  let r: any;
  let server: Connect;
  let port: number;
  let vendor: http.Server;
  const vendorKeys: string[] = [];
  const OPERATOR_KEY = ['sk', 'operator', randomBytes(12).toString('hex')].join('-');
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
    // A stand-in OpenAI that records the key each request carried (#344).
    vendor = http.createServer((req, res) => {
      req.resume();
      vendorKeys.push((req.headers.authorization ?? '').replace('Bearer ', ''));
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'x',
          object: 'chat.completion',
          created: 0,
          model: 'gpt-4o-mini',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  actions: [{ type: 'click', selector: '#total' }],
                  confidence: 0.9,
                  reasoning: 'ok',
                }),
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
    });
    await new Promise<void>((res) => vendor.listen(0, '127.0.0.1', res));
    port = await freePort();
    server = spawnConnect(port, {
      ...HOSTED_ENV,
      DATABASE_URL: dbUrl,
      IRIS_MODEL_PROBE: '0',
      // The operator's own key, which no tenant may use (#258), and the route to the fake.
      OPENAI_API_KEY: OPERATOR_KEY,
      OPENAI_BASE_URL: `http://127.0.0.1:${(vendor.address() as net.AddressInfo).port}/v1`,
    });
    const deadline = Date.now() + 30_000;
    while (!server.out.includes('listening')) {
      if (Date.now() > deadline) throw new Error(`connect never listened:\n${server.out}`);
      await new Promise((res) => setTimeout(res, 50));
    }
  }, 90_000);

  afterAll(async () => {
    vendor?.close();
    for (const ws of sockets) ws.terminate();
    if (server) {
      // Graceful shutdown is not under test here, and it waits out a 5 s timer.
      server.proc.kill('SIGKILL');
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
  function call(ws: WebSocket, method: string, params?: unknown): Promise<JsonRpcResponse> {
    const id = nextId++;
    return new Promise((resolve) => {
      const onMessage = (data: WebSocket.Data) => {
        const res = JSON.parse(data.toString()) as JsonRpcResponse;
        if (res.id !== id) return;
        ws.off('message', onMessage);
        resolve(res);
      };
      ws.on('message', onMessage);
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  test('the authenticator maps a key to its org, and refuses only when the key row agrees', () => {
    expect(r.usable).toEqual({ a: true, revoked: false, disabled: false, unknown: false });
    // Re-check by id: no plaintext, no write to the key row, and bound to the org.
    expect(r.live2).toEqual({ a: true, revoked: false, disabled: false, otherOrg: false });
    expect(r.recheckWrites).toBe(false);
    expect(r.refill).toEqual({ due: true, notYet: false, none: false });
    expect(r.downRecheck).toHaveProperty('threw');
    expect(r.live).toEqual({ orgId: r.A, keyId: r.a.id });
    expect(r.unknown).toBeNull();
    expect(r.revokedNow).toBeNull();
    expect(r.notBearer).toBeNull();
    expect(r.susp).toEqual({
      verify: 'suspended',
      recheck: 'suspended',
      otherOrg: true,
      // A dead key stays a plain refusal.
      disabledKey: false,
      restored: { orgId: r.B, keyId: r.b.id },
    });
    // The plugin failed on a key whose row is fine: an error, never "invalid key".
    expect(r.brokenVerify).toEqual({ threw: 'API key verification failed for a usable key' });
    // An unknown key stays refused even then: its row confirms it.
    expect(r.brokenUnknown).toEqual({ value: null });
    // A key store that cannot be read is "cannot tell".
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

  test("translates a tenant's instruction with its org's stored key, never the operator's (#344)", async () => {
    const tenantKey = ['sk', 'proj', randomBytes(24).toString('hex')].join('-');
    const db = createPostgresDb(dbUrl);
    try {
      await providerKeyStore(db, resolveKeyring(HOSTED_ENV)).set(r.A, 'openai', tenantKey);
    } finally {
      await db.destroy();
    }
    const ask = async (key: string) => {
      const ws = await open(`Bearer ${key}`);
      await call(ws, 'launchBrowser');
      const res = await call(ws, 'executeBrowserAction', {
        instruction: 'make sure the order total is shown',
      });
      await call(ws, 'closeBrowser');
      return res.result.translationResult;
    };
    vendorKeys.length = 0;
    // Org A stored a key: its instruction reaches the vendor with that key.
    expect((await ask(r.a.key)).method).toBe('ai');
    expect(vendorKeys).toEqual([tenantKey]);
    // Org B stored none: no AI, and nothing reaches the vendor, operator key or not.
    expect((await ask(r.b.key)).reasoning).toMatch(/no AI credentials/i);
    expect(vendorKeys).toEqual([tenantKey]);

    // Billable usage (#263): A's call on its own key, and A's browser minutes.
    const client = new Client({ connectionString: dbUrl });
    await client.connect();
    try {
      const { rows } = await client.query(
        `select org_id, kind, billing_mode, quantity::float as q, unit_cost_usd::float as cost
         from usage_events order by kind, org_id`,
      );
      const text = rows.filter((x) => x.kind === 'text_call');
      expect(text).toEqual([
        { org_id: r.A, kind: 'text_call', billing_mode: 'byok', q: 1, cost: expect.any(Number) },
      ]);
      expect(text[0].cost).toBeGreaterThan(0);
      const minutes = rows.filter((x) => x.kind === 'browser_minutes');
      // B's instruction ran no action, so no browser ever started: no minutes for B.
      expect(minutes.map((x) => x.org_id)).toEqual([r.A]);
      expect(minutes.every((x) => x.billing_mode === null && x.q > 0)).toBe(true);
    } finally {
      await client.end();
    }
  }, 60_000);

  test("records each executeBrowserAction as a run of the key's org (#254)", async () => {
    const a = await open(`Bearer ${r.a.key}`);
    await call(a, 'launchBrowser');
    // Hosted mode refuses loopback, so this action fails without any network, and a
    // failed run is still a run.
    const res = await call(a, 'executeBrowserAction', {
      actions: [{ type: 'navigate', url: 'http://127.0.0.1/' }],
    });
    await call(a, 'closeBrowser');
    expect(res.result.success).toBe(false);
    const client = new Client({ connectionString: dbUrl });
    await client.connect();
    try {
      const { rows } = await client.query(
        `select r.org_id, r.api_key_id, r.kind, r.status, rr.url, rr.passed
         from runs r join run_results rr on rr.run_id = r.id
         where rr.url = 'http://127.0.0.1/'`,
      );
      expect(rows).toEqual([
        {
          org_id: r.A,
          api_key_id: r.a.id,
          kind: 'rpc',
          status: 'failed',
          url: 'http://127.0.0.1/',
          passed: false,
        },
      ]);
    } finally {
      await client.end();
    }
  }, 60_000);

  test('a suspended org gets 403 on the upgrade and the REST API; unsuspending restores it (#348)', async () => {
    const db = createPostgresDb(dbUrl);
    const rest = (key: string) =>
      fetch(`http://127.0.0.1:${port}/v1/a11y/jobs`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ urls: ['https://example.com/'] }),
      });
    try {
      await orgSuspensions(db).suspend(r.A, { reason: 'abuse report 42', actor: 'test' });
      expect(await statusOf(open(`Bearer ${r.a.key}`))).toBe(403);
      const refused = await rest(r.a.key);
      expect(refused.status).toBe(403);
      const body = await refused.text();
      expect(JSON.parse(body)).toEqual({ error: 'Organization suspended' });
      // The operator's reason never reaches the tenant.
      expect(body).not.toMatch(/abuse report/);
      // Org B is unaffected.
      const b = await open(`Bearer ${r.b.key}`);
      expect((await call(b, 'getStatus')).result.status).toBe('ready');

      await orgSuspensions(db).unsuspend(r.A, { reason: 'resolved', actor: 'test' });
      const a = await open(`Bearer ${r.a.key}`);
      expect((await call(a, 'getStatus')).result.status).toBe('ready');
      expect((await rest(r.a.key)).status).toBe(202);
    } finally {
      await db.destroy();
    }
  }, 60_000);

  // #269: the hosted server serves the results API from the same history the RPC wrote.
  test("serves an org's recorded runs on /v1/runs, and none of them to another org (#269)", async () => {
    const get = (key: string, p: string) =>
      fetch(`http://127.0.0.1:${port}${p}`, { headers: { authorization: `Bearer ${key}` } });
    const list = await get(r.a.key, '/v1/runs');
    expect(list.status).toBe(200);
    const { runs } = await list.json();
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((run: { kind: string }) => run.kind === 'rpc')).toBe(true);
    const detail = await get(r.a.key, `/v1/runs/${runs[0].id}`);
    expect(detail.status).toBe(200);
    expect((await detail.json()).id).toBe(runs[0].id);
    // Org B reads none of org A's runs, by list or by id.
    const bList = (await (await get(r.b.key, '/v1/runs')).json()).runs.map(
      (run: { id: string }) => run.id,
    );
    expect(bList).not.toContain(runs[0].id);
    expect((await get(r.b.key, `/v1/runs/${runs[0].id}`)).status).toBe(404);
  }, 60_000);

  test('no shared token is printed in hosted mode', () => {
    expect(server.out).not.toMatch(/Auth token/);
  });
});
