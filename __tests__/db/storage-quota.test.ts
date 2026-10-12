/**
 * Per-plan artifact storage (#315), over real Postgres and a real filesystem store.
 *
 * Test strategy: a throwaway database migrated to latest, two orgs, and the filesystem
 * artifact store in a temp directory behind `orgArtifacts` (the hosted stores' contract;
 * S3 itself is covered by artifact-store.test.ts). Usage is read back from
 * `artifact_objects`, and a refused write must leave no object behind. The job API's 402
 * runs over a real socket, with the org's plan supplied as `entitlements`.
 */

import { randomBytes } from 'crypto';
import { once } from 'events';
import * as fs from 'fs';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { Kysely, sql } from 'kysely';
import { Client } from 'pg';
import { FilesystemArtifactStore, orgArtifacts } from '../../src/artifact-store';
import { createPostgresDb } from '../../src/db/postgres';
import { migrateToLatest } from '../../src/db/migrate';
import { postgresJobs, type VisualJobParams } from '../../src/history-store';
import { startServer } from '../../src/protocol';
import {
  forgetArtifacts,
  quotaArtifacts,
  StorageQuotaExceededError,
  storageUsage,
} from '../../src/storage-quota';

const ADMIN_URL = process.env.IRIS_TEST_DATABASE_URL;
if (!ADMIN_URL) {
  if (process.env.CI) throw new Error('IRIS_TEST_DATABASE_URL is required in CI');
  console.warn('Skipping storage quota tests: set IRIS_TEST_DATABASE_URL');
}

const VISUAL: VisualJobParams = {
  project: 'shop',
  urls: ['https://example.com/'],
  devices: ['desktop'],
  threshold: 0.01,
};

(ADMIN_URL ? describe : describe.skip)('artifact storage quota (#315)', () => {
  const dbName = `iris_quota_${process.pid}_${randomBytes(4).toString('hex')}`;
  let db: Kysely<unknown>;
  let root: string;
  let store: FilesystemArtifactStore;

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
    db = createPostgresDb(u.toString());
    await migrateToLatest(db);
    for (const org of ['org-a', 'org-b']) {
      await sql`insert into organization (id, name, slug, "createdAt")
        values (${org}, ${org}, ${org}, now())`.execute(db);
    }
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-quota-'));
    store = new FilesystemArtifactStore(root);
  });

  afterAll(async () => {
    await db?.destroy();
    await admin(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await sql`delete from artifact_objects`.execute(db);
    await sql`delete from runs`.execute(db);
  });

  const key = (org: string, name: string) => `org/${org}/project/shop/run/r1/current/${name}.png`;
  const bytes = (n: number) => Buffer.alloc(n, 1);
  const quota = (org: string, limit: number) =>
    quotaArtifacts(orgArtifacts(store, org), db, org, limit);

  it('records what an org stores, per org, and counts a replaced key once', async () => {
    const a = quota('org-a', 1_000);
    await a.put(key('org-a', 'one'), bytes(300), 'image/png');
    await a.put(key('org-a', 'two'), bytes(200), 'image/png');
    await a.put(key('org-a', 'one'), bytes(100), 'image/png'); // replaced: 100, not 400
    await quota('org-b', 1_000).put(key('org-b', 'one'), bytes(50), 'image/png');
    expect(await storageUsage(db, 'org-a')).toBe(300);
    expect(await storageUsage(db, 'org-b')).toBe(50);
  });

  it('refuses a write past the quota, and stores nothing of it', async () => {
    const a = quota('org-a', 500);
    await a.put(key('org-a', 'fits'), bytes(400), 'image/png');
    await expect(a.put(key('org-a', 'over'), bytes(200), 'image/png')).rejects.toMatchObject({
      name: 'StorageQuotaExceededError',
      limit: 500,
      used: 400,
    });
    expect(await store.get(key('org-a', 'over'))).toBeNull();
    expect(await storageUsage(db, 'org-a')).toBe(400);
  });

  it('forgets what a purge deletes', async () => {
    const a = quota('org-a', 1_000);
    await a.put(key('org-a', 'one'), bytes(300), 'image/png');
    await a.put('org/org-a/project/blog/baselines/x.png', bytes(100), 'image/png');
    await a.deletePrefix('org/org-a/project/shop/');
    expect(await storageUsage(db, 'org-a')).toBe(100);
    await forgetArtifacts(db, 'org-a', 'org/org-a/');
    expect(await storageUsage(db, 'org-a')).toBe(0);
  });

  it('refuses a visual job submit at the quota, and never an a11y one', async () => {
    await quota('org-a', 1_000).put(key('org-a', 'one'), bytes(1_000), 'image/png');
    const jobs = postgresJobs(db).forOrg({ orgId: 'org-a' });
    await expect(
      jobs.enqueue({ kind: 'visual', params: VISUAL }, { storageLimitBytes: 1_000 }),
    ).rejects.toBeInstanceOf(StorageQuotaExceededError);
    expect(
      await jobs.enqueue(
        {
          kind: 'a11y',
          params: { urls: ['https://example.com/'], wcagLevel: 'AA', failOn: ['serious'] },
        },
        { storageLimitBytes: 1_000 },
      ),
    ).toEqual(expect.any(String));
    // Another org is not affected by org-a's usage.
    expect(
      await postgresJobs(db)
        .forOrg({ orgId: 'org-b' })
        .enqueue({ kind: 'visual', params: VISUAL }, { storageLimitBytes: 1_000 }),
    ).toEqual(expect.any(String));
  });

  it('answers a visual submit over the quota with 402 and the numbers', async () => {
    await quota('org-a', 1_000).put(key('org-a', 'one'), bytes(1_000), 'image/png');
    const server = startServer(0, {
      authenticate: {
        verify: async () => ({ orgId: 'org-a', keyId: 'key-a' }),
        recheck: async () => true,
      },
      jobs: postgresJobs(db),
      artifacts: store,
      entitlements: async () => ({ runsPerMonth: 1_000, artifactStorageBytes: 1_000 }),
    });
    await once(server, 'listening');
    try {
      const res = await fetch(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/visual/jobs`,
        {
          method: 'POST',
          headers: { authorization: 'Bearer iris_test', 'content-type': 'application/json' },
          body: JSON.stringify({ project: 'shop', urls: ['https://example.com/'] }),
        },
      );
      expect(res.status).toBe(402);
      expect(await res.json()).toEqual({
        error: 'Storage quota reached',
        limit: 1_000,
        used: 1_000,
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
