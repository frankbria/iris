/**
 * `iris admin suspend-org | unsuspend-org | org-status` (#348).
 *
 * Test strategy: the CLI as a spawned process (ts-node, transpile-only), as an operator
 * runs it with `docker compose exec`. Real Postgres for the state changes; the refusals
 * that need no database (not hosted, unreachable database, blank reason) always run.
 */

import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import * as path from 'path';
import { Kysely, sql } from 'kysely';
import { Client } from 'pg';
import { createPostgresDb } from '../src/db/postgres';
import { migrateToLatest } from '../src/db/migrate';

const ADMIN_URL = process.env.IRIS_TEST_DATABASE_URL;
const REPO_ROOT = path.resolve(__dirname, '..');

if (!ADMIN_URL) {
  if (process.env.CI) throw new Error('IRIS_TEST_DATABASE_URL is required in CI');
  console.warn('Skipping admin CLI database tests: set IRIS_TEST_DATABASE_URL');
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function iris(args: string[], env: NodeJS.ProcessEnv = {}): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['-r', 'ts-node/register', path.join(REPO_ROOT, 'src/cli.ts'), ...args],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, TS_NODE_TRANSPILE_ONLY: '1', IRIS_HOSTED: '1', ...env },
        timeout: 60_000,
      },
      (err, stdout, stderr) =>
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });
}

describe('iris admin refusals', () => {
  test('outside hosted mode it exits 2', async () => {
    const r = await iris(['admin', 'org-status', 'org-x'], {
      IRIS_HOSTED: '',
      DATABASE_URL: 'postgres://x@[::1]:1/x',
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/hosted mode only/);
  }, 60_000);

  test('an unreachable database exits 3', async () => {
    // [::1] refuses at once; 127.0.0.1 can blackhole on WSL (#382).
    const r = await iris(['admin', 'org-status', 'org-x'], {
      DATABASE_URL: 'postgres://x:y@[::1]:1/x',
    });
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/Cannot open the database/);
  }, 60_000);

  test('a missing or blank reason is refused before the database is touched', async () => {
    const env = { DATABASE_URL: 'postgres://x:y@[::1]:1/x' };
    const missing = await iris(['admin', 'suspend-org', 'org-x'], env);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toMatch(/--reason/);
    const blank = await iris(['admin', 'suspend-org', 'org-x', '--reason', '  '], env);
    expect(blank.code).toBe(2);
  }, 60_000);
});

(ADMIN_URL ? describe : describe.skip)('iris admin against Postgres', () => {
  const dbName = `iris_admin_${process.pid}_${randomBytes(4).toString('hex')}`;
  let db: Kysely<unknown>;
  let env: NodeJS.ProcessEnv;

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
    env = { DATABASE_URL: u.toString(), IRIS_LOG_LEVEL: 'info', SUDO_USER: '', USER: 'deployer' };
    db = createPostgresDb(u.toString());
    await migrateToLatest(db);
    await sql`insert into organization (id, name, slug, "createdAt")
      values ('org-a', 'A', 'a', now())`.execute(db);
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
    await admin(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  });

  test('suspend, repeat, status, unsuspend: every change recorded with actor and reason', async () => {
    const s = await iris(
      ['admin', 'suspend-org', 'org-a', '--reason', 'phishing report #12', '--actor', 'alice'],
      env,
    );
    expect(s).toMatchObject({ code: 0, stdout: 'org org-a is now suspended\n' });
    // Logged through log.ts (JSON on stderr in hosted mode), with org and actor.
    const line = JSON.parse(s.stderr.trim().split('\n').pop()!);
    expect(line).toMatchObject({
      level: 'info',
      msg: 'org suspended',
      orgId: 'org-a',
      actor: 'alice',
    });

    const again = await iris(['admin', 'suspend-org', 'org-a', '--reason', 'dup'], env);
    expect(again).toMatchObject({
      code: 0,
      stdout: 'org org-a is already suspended; nothing recorded\n',
    });

    // Default actor: $SUDO_USER, else $USER.
    const u = await iris(['admin', 'unsuspend-org', 'org-a', '--reason', 'resolved'], env);
    expect(u).toMatchObject({ code: 0, stdout: 'org org-a is now active\n' });

    const status = await iris(['admin', 'org-status', 'org-a'], env);
    expect(status.code).toBe(0);
    const lines = status.stdout.trim().split('\n');
    expect(lines[0]).toBe('org org-a: active');
    expect(lines.slice(1)).toEqual([
      expect.stringMatching(/^\d{4}-\d\d-\d\dT\S+Z {2}suspend {4}by alice: phishing report #12$/),
      expect.stringMatching(/ {2}unsuspend {2}by deployer: resolved$/),
    ]);

    const { rows } = await sql<{ n: string }>`select count(*) as n from org_suspensions`.execute(
      db,
    );
    expect(rows[0].n).toBe('2');
  }, 120_000);

  test('sudo names the operator, not root', async () => {
    const r = await iris(['admin', 'suspend-org', 'org-a', '--reason', 'x'], {
      ...env,
      SUDO_USER: 'bob',
      USER: 'root',
    });
    expect(r.code).toBe(0);
    const { rows } = await sql<{ actor: string }>`
      select actor from org_suspensions order by created_at desc limit 1`.execute(db);
    expect(rows[0].actor).toBe('bob');
    await iris(['admin', 'unsuspend-org', 'org-a', '--reason', 'x'], env);
  }, 120_000);

  test('an unknown org exits 1 and records nothing', async () => {
    for (const args of [
      ['suspend-org', 'org-nope', '--reason', 'x'],
      ['unsuspend-org', 'org-nope', '--reason', 'x'],
      ['org-status', 'org-nope'],
    ]) {
      const r = await iris(['admin', ...args], env);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/No organization with id "org-nope"/);
    }
    const { rows } = await sql`select 1 from org_suspensions where org_id = 'org-nope'`.execute(db);
    expect(rows).toEqual([]);
  }, 120_000);

  test('an org never suspended reads as active with no history', async () => {
    await sql`insert into organization (id, name, slug, "createdAt")
      values ('org-b', 'B', 'b', now())`.execute(db);
    const r = await iris(['admin', 'org-status', 'org-b'], env);
    expect(r).toMatchObject({ code: 0, stdout: 'org org-b: active\nno suspension history\n' });
  }, 60_000);

  // #349: deletion is a soft delete the operator can undo, then retention purges it.
  test('delete-org, restore-org, delete-user and retention', async () => {
    await sql`insert into organization (id, name, slug, "createdAt")
      values ('org-d', 'D', 'd', now())`.execute(db);
    // An owner: restoring an org nobody owns is refused.
    await sql`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      values ('u-owner', 'O', 'owner@iris.test', true, now(), now())`.execute(db);
    await sql`insert into member (id, "organizationId", "userId", role, "createdAt")
      values ('m-owner', 'org-d', 'u-owner', 'owner', now())`.execute(db);
    const del = await iris(['admin', 'delete-org', 'org-d', '--reason', 'customer request'], env);
    expect(del.code).toBe(0);
    expect(del.stdout).toMatch(/^org org-d is suspended; its data is purged after \d{4}-/);
    const again = await iris(['admin', 'delete-org', 'org-d', '--reason', 'x'], env);
    expect(again.code).toBe(1);
    expect(again.stderr).toMatch(/already requested/);

    expect(await iris(['admin', 'restore-org', 'org-d'], env)).toMatchObject({
      code: 0,
      stdout: 'deletion of org org-d cancelled\n',
    });
    expect((await iris(['admin', 'restore-org', 'org-d'], env)).code).toBe(1);

    await sql`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      values ('u-gone', 'G', 'gone@iris.test', true, now(), now())`.execute(db);
    expect(await iris(['admin', 'delete-user', 'u-gone'], env)).toMatchObject({
      code: 0,
      stdout: 'user u-gone deleted\n',
    });
    expect((await iris(['admin', 'delete-user', 'u-gone'], env)).code).toBe(1);

    const r = await iris(['admin', 'retention'], env);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      orgsPurged: [],
      aiLedgerRows: 0,
      aiCacheRows: 0,
    });
  }, 240_000);

  // #472: a broken store config is reported, and the rest of the pass still runs.
  test('retention with a partial IRIS_S3_* still runs, then exits 3', async () => {
    const r = await iris(['admin', 'retention'], { ...env, IRIS_S3_BUCKET: 'iris' });
    expect(r.code).toBe(3);
    const report = JSON.parse(r.stdout);
    expect(report.failures).toEqual([expect.stringMatching(/^artifact store: IRIS_S3_BUCKET set/)]);
    expect(report).toHaveProperty('sessionsDeleted');
  }, 120_000);
});
