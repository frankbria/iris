/**
 * Hosted Postgres: connection, migration runner and initial schema (#248).
 *
 * Test strategy: a real Postgres, no fakes. `IRIS_TEST_DATABASE_URL` is an admin
 * URL (docker-compose.dev.yml locally, a service container in CI); each file
 * creates its own throwaway database and drops it afterwards, so runs never see
 * each other's migrations. Required under CI, skipped with a notice locally.
 *
 * The tenancy test reads the catalog rather than a hard-coded table list, so a
 * table added by a later migration without `org_id` fails here too.
 *
 * BetterAuth is ESM-only and Jest's sandbox cannot `require(esm)`, so the check
 * that `createAuth()` works against the migrated schema runs in a spawned Node,
 * as `auth-config.test.ts` does.
 */

import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { Kysely, sql } from 'kysely';
import { Client } from 'pg';
import { createPostgresDb, resolveDatabaseUrl } from '../../src/db/postgres';
import { migrateToLatest } from '../../src/db/migrate';

const ADMIN_URL = process.env.IRIS_TEST_DATABASE_URL;
const REPO_ROOT = path.resolve(__dirname, '../..');

if (!ADMIN_URL) {
  if (process.env.CI) throw new Error('IRIS_TEST_DATABASE_URL is required in CI');
  console.warn('Skipping Postgres tests: set IRIS_TEST_DATABASE_URL (see docker-compose.dev.yml)');
}

/** BetterAuth's tables (generated, its own column names); every other table is IRIS's. */
const BETTER_AUTH_TABLES = [
  'account',
  'apikey',
  'invitation',
  'member',
  'organization',
  'session',
  'user',
  'verification',
];

describe('resolveDatabaseUrl', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-dburl-'));
  const file = path.join(dir, 'database_url');

  it('reads DATABASE_URL', () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: 'postgres://a@b/c' })).toBe('postgres://a@b/c');
  });

  it('reads DATABASE_URL_FILE and trims the trailing newline', () => {
    fs.writeFileSync(file, 'postgres://x@y/z\n');
    expect(resolveDatabaseUrl({ DATABASE_URL_FILE: file })).toBe('postgres://x@y/z');
  });

  it('refuses both at once, neither, and an empty file', () => {
    fs.writeFileSync(file, 'postgres://x@y/z');
    expect(() => resolveDatabaseUrl({ DATABASE_URL: 'a', DATABASE_URL_FILE: file })).toThrow(
      /one at a time/,
    );
    expect(() => resolveDatabaseUrl({})).toThrow(/DATABASE_URL/);
    fs.writeFileSync(file, '\n');
    expect(() => resolveDatabaseUrl({ DATABASE_URL_FILE: file })).toThrow(/empty/);
  });
});

describe('migrate process against a server that never answers', () => {
  // A deploy step must fail, not hang, when the database is unreachable. A
  // listener that accepts and stays silent is a blackhole on every host (the
  // 127.0.0.1:1 trick refuses on Linux CI but blackholes on WSL, #382).
  it('gives up with exit 1 and a timeout message, without printing the password', async () => {
    const silent = net.createServer(() => {});
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const { port } = silent.address() as net.AddressInfo;
    try {
      const err = await promisify(execFile)(
        process.execPath,
        ['-r', 'ts-node/register', 'src/db/migrate.ts'],
        {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            TS_NODE_TRANSPILE_ONLY: '1',
            DATABASE_URL: `postgres://iris:s3cret-pw@127.0.0.1:${port}/iris`,
          },
        },
      ).catch((e: { code: number; stderr: string; stdout: string }) => e);
      expect(err).toMatchObject({ code: 1, stderr: expect.stringMatching(/timeout/i) });
      expect(
        `${(err as { stdout: string }).stdout}${(err as { stderr: string }).stderr}`,
      ).not.toMatch(/s3cret-pw/);
    } finally {
      silent.close();
    }
  }, 30_000);
});

(ADMIN_URL ? describe : describe.skip)(
  'createPostgresDb when the server ends an idle connection',
  () => {
    // A Postgres restart terminates every pooled connection. `pg` then emits 'error'
    // on the pool, and with no listener that is an uncaught exception: the hosted
    // server exited mid-demo when the database was stopped (#341).
    it('survives and serves the next query on a fresh connection', async () => {
      const db = createPostgresDb(ADMIN_URL!);
      const admin = new Client({ connectionString: ADMIN_URL });
      await admin.connect();
      try {
        const { rows } = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db);
        // The pool now holds that connection idle; end it from the server side.
        await admin.query('select pg_terminate_backend($1)', [rows[0].pid]);
        await new Promise((r) => setTimeout(r, 300));
        const after = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db);
        expect(after.rows[0].pid).not.toBe(rows[0].pid);
      } finally {
        await admin.end();
        await db.destroy();
      }
    });
  },
);

(ADMIN_URL ? describe : describe.skip)('createPostgresDb query timeout', () => {
  // A server that accepted the connection and then stopped answering: connect
  // timeouts do not cover it. pg_sleep stands in for the stall (#341).
  it('fails a query that outlives queryTimeoutMs, and leaves the default unbounded', async () => {
    const bounded = createPostgresDb(ADMIN_URL!, { queryTimeoutMs: 200 });
    const unbounded = createPostgresDb(ADMIN_URL!);
    try {
      await expect(sql`select pg_sleep(2)`.execute(bounded)).rejects.toThrow(/timeout/i);
      // The pool is still usable afterwards.
      expect((await sql<{ n: number }>`select 1 as n`.execute(bounded)).rows[0].n).toBe(1);
      // Migrations use the default: a long statement must not be cut off.
      await expect(sql`select pg_sleep(0.5)`.execute(unbounded)).resolves.toBeDefined();
    } finally {
      await bounded.destroy();
      await unbounded.destroy();
    }
  });
});

(ADMIN_URL ? describe : describe.skip)('Postgres migrations', () => {
  const dbName = `iris_test_${process.pid}_${randomBytes(4).toString('hex')}`;
  let url: string;
  let db: Kysely<any>;

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
    url = u.toString();
    db = createPostgresDb(url);
  });

  afterAll(async () => {
    await db?.destroy();
    await admin(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  });

  it('applies every migration, in order, to an empty database', async () => {
    const results = await migrateToLatest(db);
    expect(results.map((r) => [r.migrationName, r.status])).toEqual([
      ['0001_initial', 'Success'],
      ['0002_history', 'Success'],
      ['0003_usage', 'Success'],
      ['0004_jobs', 'Success'],
    ]);

    const tables = await sql<{ table_name: string }>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'`.execute(db);
    expect(tables.rows.map((r) => r.table_name)).toEqual(
      expect.arrayContaining([
        ...BETTER_AUTH_TABLES,
        'runs',
        'run_results',
        'usage_events',
        'provider_keys',
        'audit_log',
      ]),
    );
  });

  it('is idempotent: a second run applies nothing', async () => {
    expect(await migrateToLatest(db)).toEqual([]);
    const applied = await sql<{ n: string }>`select count(*) as n from kysely_migration`.execute(
      db,
    );
    expect(applied.rows[0].n).toBe('4');
  });

  it('gives every IRIS table org_id NOT NULL and an index that leads with it', async () => {
    // Every public base table that is neither BetterAuth's nor Kysely's bookkeeping.
    const rows = await sql<{ table_name: string; nullable: string | null; leads: boolean }>`
      select t.table_name,
             c.is_nullable as nullable,
             exists (
               select 1 from pg_index i
               join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
               where i.indrelid = format('public.%I', t.table_name)::regclass
                 and a.attname = 'org_id'
             ) as leads
      from information_schema.tables t
      left join information_schema.columns c
        on c.table_schema = t.table_schema and c.table_name = t.table_name
       and c.column_name = 'org_id'
      where t.table_schema = 'public' and t.table_type = 'BASE TABLE'
        and t.table_name not like 'kysely\\_%'`.execute(db);

    const tenant = rows.rows.filter((r) => !BETTER_AUTH_TABLES.includes(r.table_name));
    // Guards against a filter that matches nothing and passes vacuously.
    expect(tenant.length).toBeGreaterThanOrEqual(5);
    for (const r of tenant) {
      expect({ table: r.table_name, nullable: r.nullable, leads: r.leads }).toEqual({
        table: r.table_name,
        nullable: 'NO',
        leads: true,
      });
    }
  });

  it("refuses a run result that points at another org's run", async () => {
    for (const id of ['org_a', 'org_b']) {
      await sql`insert into organization (id, name, slug, "createdAt")
                values (${id}, ${id}, ${id}, now())`.execute(db);
    }
    const run = await sql<{ id: string }>`
      insert into runs (org_id, kind) values ('org_a', 'a11y') returning id`.execute(db);
    const runId = run.rows[0].id;

    await sql`insert into run_results (org_id, run_id) values ('org_a', ${runId})`.execute(db);
    await expect(
      sql`insert into run_results (org_id, run_id) values ('org_b', ${runId})`.execute(db),
    ).rejects.toThrow(/foreign key/);
  });

  it('rejects a usage event replayed with the same idempotency key', async () => {
    const insert = () =>
      // An AI row carries its unit cost since #263 (usage_events_ai_cost_check).
      sql`insert into usage_events (org_id, kind, quantity, billing_mode, idempotency_key, unit_cost_usd)
          values ('org_a', 'vision_call', 1, 'managed', 'k-1', 0.01)`.execute(db);
    await insert();
    await expect(insert()).rejects.toThrow(/duplicate key/);
  });

  it('runs as a process: `migrate` exits 0 when current, non-zero when it cannot connect', async () => {
    const run = (env: Record<string, string>) =>
      promisify(execFile)(process.execPath, ['-r', 'ts-node/register', 'src/db/migrate.ts'], {
        cwd: REPO_ROOT,
        env: { ...process.env, TS_NODE_TRANSPILE_ONLY: '1', ...env },
      });

    const ok = await run({ DATABASE_URL: url });
    expect(ok.stdout).toMatch(/up to date/);

    const bad = new URL(url);
    bad.password = 'wrong-password';
    await expect(run({ DATABASE_URL: bad.toString() })).rejects.toMatchObject({ code: 1 });
  }, 30_000);

  it('serves BetterAuth: sign-up, organization and an org-owned API key', async () => {
    const PROBE = `
      const { Pool } = require('pg');
      const { createAuth } = require('./src/auth/config.ts');
      (async () => {
        const pool = new Pool({ connectionString: process.env.PROBE_URL });
        const auth = createAuth({
          secret: process.env.PROBE_SECRET,
          baseURL: 'http://localhost:3000',
          database: pool,
          sendEmail: async () => {},
        });
        const { user } = await auth.api.signUpEmail({
          body: { email: 'probe@example.com', password: 'correct-horse-battery', name: 'Probe' },
        });
        const org = await auth.api.createOrganization({
          body: { name: 'Probe Org', slug: 'probe-org', userId: user.id },
        });
        const key = await auth.api.createApiKey({ body: { name: 'probe', organizationId: org.id, userId: user.id } });
        const verified = await auth.api.verifyApiKey({ body: { key: key.key } });
        await pool.end();
        process.stdout.write(JSON.stringify({
          valid: verified.valid,
          owner: verified.key && verified.key.referenceId === org.id,
        }));
      })().catch((e) => { console.error(e); process.exit(1); });
    `;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['-r', 'ts-node/register', '-e', PROBE],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          TS_NODE_TRANSPILE_ONLY: '1',
          BETTER_AUTH_TELEMETRY: '0',
          PROBE_URL: url,
          PROBE_SECRET: randomBytes(32).toString('hex'),
        },
      },
    );
    expect(JSON.parse(stdout)).toEqual({ valid: true, owner: true });
  }, 30_000);
});
