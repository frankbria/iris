/**
 * The tenant-scoped history store (#254) over real Postgres.
 *
 * Test strategy: a throwaway database migrated to latest, with two orgs and one
 * API key each inserted directly (BetterAuth is not needed to own rows). Every
 * scenario goes through `postgresHistory(db).forOrg(scope)`, the only way to reach
 * the store, and the tenant boundary is checked both through the store and against
 * the tables themselves.
 */

import { randomBytes } from 'crypto';
import { Kysely, sql } from 'kysely';
import { Client } from 'pg';
import { createPostgresDb } from '../../src/db/postgres';
import { migrateToLatest } from '../../src/db/migrate';
import { InvalidCursorError, postgresHistory, RunInput } from '../../src/history-store';
import type { VisualTestResult } from '../../src/visual/visual-runner';
import type { AccessibilityTestResult } from '../../src/a11y/a11y-runner';

const ADMIN_URL = process.env.IRIS_TEST_DATABASE_URL;

if (!ADMIN_URL) {
  if (process.env.CI) throw new Error('IRIS_TEST_DATABASE_URL is required in CI');
  console.warn('Skipping history store tests: set IRIS_TEST_DATABASE_URL');
}

const started = new Date('2026-10-01T10:00:00Z');
// URL credentials for the stripping tests, built at runtime: a `user:pass@` literal
// in source reads to secret scanners as a leaked Basic Auth string.
const USERINFO = ['tester', 'not-a-secret'].join(':');
const finished = new Date('2026-10-01T10:00:05Z');

/** An RPC request of two actions, one a fill whose value must never be stored. */
const rpcRun: RunInput = {
  kind: 'rpc',
  startedAt: started,
  finishedAt: finished,
  success: false,
  results: [
    {
      success: true,
      action: { type: 'navigate', url: 'https://shop.example/login' },
      context: { url: 'https://shop.example/login', timestamp: 1 },
    },
    {
      success: false,
      action: { type: 'fill', selector: '#password', text: 'hunter2-secret' },
      error: 'Timeout waiting for #password',
    },
  ],
};

const visualRun = {
  kind: 'visual',
  startedAt: started,
  finishedAt: finished,
  result: {
    summary: { totalComparisons: 1, failed: 1, overallStatus: 'failed' },
    results: [
      {
        page: '/about',
        device: 'mobile',
        passed: false,
        similarity: 0.85,
        severity: 'breaking',
        screenshotPath: '/tmp/about.png',
      },
    ],
  } as unknown as VisualTestResult,
} satisfies RunInput;

const a11yRun = {
  kind: 'a11y',
  startedAt: started,
  finishedAt: finished,
  result: {
    summary: { pagesTested: 1, totalViolations: 2, passed: false },
    results: [
      {
        page: '/checkout',
        axeResult: { violations: [{ impact: 'critical' }, { impact: 'minor' }] },
        keyboardResult: { passed: true },
      },
    ],
  } as unknown as AccessibilityTestResult,
} satisfies RunInput;

(ADMIN_URL ? describe : describe.skip)('postgresHistory (tenant-scoped)', () => {
  const dbName = `iris_hist_${process.pid}_${randomBytes(4).toString('hex')}`;
  let db: Kysely<unknown>;

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
    for (const org of ['org-a', 'org-b', 'org-c']) {
      await sql`insert into organization (id, name, slug, "createdAt")
        values (${org}, ${org}, ${org}, now())`.execute(db);
      await sql`insert into apikey (id, "configId", "referenceId", key, "createdAt", "updatedAt")
        values (${`key-${org}`}, 'default', ${org}, ${`hash-${org}`}, now(), now())`.execute(db);
    }
  });

  afterAll(async () => {
    await db?.destroy();
    await admin(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  });

  const history = () => postgresHistory(db);
  const A = { orgId: 'org-a', apiKeyId: 'key-org-a' };
  const B = { orgId: 'org-b', apiKeyId: 'key-org-b' };

  it('records an RPC run with its org and key, one result per action', async () => {
    const id = await history().forOrg(A).record(rpcRun);
    const run = await history().forOrg(A).get(id);
    expect(run).toMatchObject({
      id,
      kind: 'rpc',
      status: 'failed',
      summary: 'rpc: 2 action(s), 1 failed',
      startedAt: started,
      finishedAt: finished,
    });
    expect(run!.results).toEqual([
      {
        url: 'https://shop.example/login',
        passed: true,
        result: { action: 'navigate https://shop.example/login' },
      },
      {
        url: null,
        passed: false,
        result: { action: 'fill #password = <redacted>', error: 'Timeout waiting for #password' },
      },
    ]);
    const row = await sql<{ org_id: string; api_key_id: string }>`
      select org_id, api_key_id from runs where id = ${id}`.execute(db);
    expect(row.rows[0]).toEqual({ org_id: 'org-a', api_key_id: 'key-org-a' });
  });

  it('never stores a typed value', async () => {
    const id = await history().forOrg(A).record(rpcRun);
    const dump = await sql<{ t: string }>`
      select (select row_to_json(r)::text from runs r where id = ${id})
        || (select json_agg(rr)::text from run_results rr where run_id = ${id}) as t`.execute(db);
    expect(dump.rows[0].t).not.toContain('hunter2-secret');
  });

  it('records visual and a11y runs with one result per page', async () => {
    const store = history().forOrg(B);
    const v = await store.get(await store.record(visualRun));
    expect(v).toMatchObject({
      kind: 'visual',
      status: 'failed',
      summary: 'visual: 1 comparison(s), 1 failed',
    });
    expect(v!.results).toEqual([
      {
        url: '/about',
        passed: false,
        result: { device: 'mobile', diffPercentage: expect.closeTo(0.15), severity: 'breaking' },
      },
    ]);
    const a = await store.get(await store.record(a11yRun));
    expect(a).toMatchObject({
      kind: 'a11y',
      status: 'failed',
      summary: 'a11y: 1 page(s), 2 violation(s)',
    });
    expect(a!.results).toEqual([
      {
        url: '/checkout',
        passed: false,
        result: {
          violations: { critical: 1, serious: 0, moderate: 0, minor: 1 },
          keyboardPassed: true,
          screenReaderPassed: true,
          score: expect.any(Number),
        },
      },
    ]);
  });

  it('lists only the caller org runs, newest first, and cannot read across orgs', async () => {
    const aId = await history().forOrg(A).record(rpcRun);
    const listedA = await history().forOrg(A).list();
    const listedB = await history().forOrg(B).list();
    expect(listedA.map((r) => r.id)).toContain(aId);
    expect(listedB.map((r) => r.id)).not.toContain(aId);
    expect(listedB.every((r) => r.kind !== 'rpc')).toBe(true);
    // By id, too: another org's run does not exist for this org.
    expect(await history().forOrg(B).get(aId)).toBeNull();
    expect(await history().forOrg(B).get('not-a-uuid')).toBeNull();
    const created = listedA.map((r) => r.createdAt.getTime());
    expect([...created].sort((x, y) => y - x)).toEqual(created);
    expect(await history().forOrg(A).list({ limit: 1 })).toHaveLength(1);
  });

  it("never records another org's key, or a key revoked mid-request: the run stays, keyless", async () => {
    for (const apiKeyId of ['key-org-a', 'key-already-revoked']) {
      const id = await history().forOrg({ orgId: 'org-b', apiKeyId }).record(rpcRun);
      const row = await sql<{ org_id: string; api_key_id: string | null }>`
        select org_id, api_key_id from runs where id = ${id}`.execute(db);
      expect(row.rows[0]).toEqual({ org_id: 'org-b', api_key_id: null });
    }
    // The constraint is what refuses it, not the store being lax.
    await expect(
      sql`insert into runs (org_id, api_key_id, kind) values ('org-b', 'key-org-a', 'rpc')`.execute(
        db,
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it('keeps results in the order they ran, and strips credentials from URLs', async () => {
    const actions = Array.from({ length: 8 }, (_, i) => ({
      success: i % 2 === 0,
      action: { type: 'navigate' as const, url: `https://${USERINFO}@site.example/${i}?q=${i}` },
    }));
    const id = await history().forOrg(A).record({
      kind: 'rpc',
      success: false,
      startedAt: started,
      finishedAt: finished,
      results: actions,
    });
    const run = await history().forOrg(A).get(id);
    expect(run!.results.map((r) => r.url)).toEqual(
      actions.map((_, i) => `https://site.example/${i}?q=${i}`),
    );
    expect(JSON.stringify(run)).not.toContain(USERINFO);
  });

  it('cuts a long error between characters, never inside one', async () => {
    // 499 ASCII characters, then an emoji: two UTF-16 units straddling unit 500.
    // A cut between them leaves a lone surrogate, which Postgres's json input
    // rejects, and the whole run would be lost.
    const error = 'x'.repeat(499) + '😀' + 'tail';
    const id = await history()
      .forOrg(A)
      .record({
        kind: 'rpc',
        success: false,
        startedAt: started,
        finishedAt: finished,
        results: [{ success: false, action: { type: 'click', selector: '#a' }, error }],
      });
    const stored = (await history().forOrg(A).get(id))!.results[0].result.error as string;
    expect([...stored]).toHaveLength(500);
    expect(stored.endsWith('😀')).toBe(true);
  });

  it('records a run whose strings hold a lone surrogate instead of losing it', async () => {
    // A client can send "\ud800" as a JSON escape in a selector, and errors quote
    // selectors. JSON.stringify keeps it as an escape Postgres's jsonb rejects.
    const lone = String.fromCharCode(0xd800);
    const id = await history()
      .forOrg(A)
      .record({
        kind: 'rpc',
        success: false,
        startedAt: started,
        finishedAt: finished,
        results: [
          {
            success: false,
            action: { type: 'click', selector: `#a${lone}` },
            error: `no element #a${lone}`,
          },
        ],
      });
    const run = await history().forOrg(A).get(id);
    expect(run!.results[0].result).toEqual({
      action: 'click #a\ufffd',
      error: 'no element #a\ufffd',
    });
  });

  it('records a run whose strings hold a NUL instead of losing it', async () => {
    // Postgres rejects U+0000 in jsonb and in text. A selector can carry one as a
    // JSON escape from the wire, and a navigate URL keeps it in the url column.
    const nul = String.fromCharCode(0);
    const id = await history()
      .forOrg(A)
      .record({
        kind: 'rpc',
        success: false,
        startedAt: started,
        finishedAt: finished,
        results: [
          { success: false, action: { type: 'click', selector: `#a${nul}` }, error: `bad${nul}` },
          { success: false, action: { type: 'navigate', url: `https://site.example/${nul}` } },
        ],
      });
    const run = await history().forOrg(A).get(id);
    expect(run!.results[0].result).toEqual({ action: 'click #a\ufffd', error: 'bad\ufffd' });
    expect(run!.results[1].url).toBe('https://site.example/\ufffd');
  });

  it('strips credentials from an action description too', async () => {
    const id = await history()
      .forOrg(A)
      .record({
        kind: 'rpc',
        success: true,
        startedAt: started,
        finishedAt: finished,
        results: [
          {
            success: true,
            action: {
              type: 'assert',
              kind: 'url_matches',
              target: `https://${USERINFO}@shop.example/`,
            },
          },
        ],
      });
    const stored = JSON.stringify(await history().forOrg(A).get(id));
    expect(stored).not.toContain(USERINFO);
    expect(stored).toContain('assert url_matches https://shop.example/');
  });

  it('strips credentials from URLs quoted in an error message too', async () => {
    const id = await history()
      .forOrg(A)
      .record({
        kind: 'rpc',
        success: false,
        startedAt: started,
        finishedAt: finished,
        results: [
          {
            success: false,
            action: { type: 'navigate', url: `https://${USERINFO}@site.example/x` },
            // guardedGoto and Playwright both quote the URL they were given.
            error: `Navigation to https://${USERINFO}@site.example/x refused; see ftp://${USERINFO}@h/`,
          },
        ],
      });
    const run = await history().forOrg(A).get(id);
    expect(run!.results[0].result.error).toBe(
      'Navigation to https://site.example/x refused; see ftp://h/',
    );
  });

  it('keeps the run when its key is deleted, with no key recorded', async () => {
    await sql`insert into apikey (id, "configId", "referenceId", key, "createdAt", "updatedAt")
      values ('key-temp', 'default', 'org-a', 'hash-temp', now(), now())`.execute(db);
    const id = await history().forOrg({ orgId: 'org-a', apiKeyId: 'key-temp' }).record(rpcRun);
    await sql`delete from apikey where id = 'key-temp'`.execute(db);
    const row = await sql<{ api_key_id: string | null; org_id: string }>`
      select org_id, api_key_id from runs where id = ${id}`.execute(db);
    expect(row.rows[0]).toEqual({ org_id: 'org-a', api_key_id: null });
  });

  it('has the (org_id, created_at) index the list query uses', async () => {
    const idx = await sql<{ indexdef: string }>`
      select indexdef from pg_indexes where tablename = 'runs'`.execute(db);
    const defs = idx.rows.map((r) => r.indexdef).join('\n');
    expect(defs).toMatch(/\(org_id, created_at\)/);
    // Revoking a key looks its runs up by this.
    expect(defs).toMatch(/\(org_id, api_key_id\)/);
  });
  // #269: keyset pages over (created_at desc, id desc). Rows are inserted directly so the
  // test controls created_at, including exact ties, which a cursor on created_at alone
  // would skip or repeat.
  describe('listPage (#269)', () => {
    const C = { orgId: 'org-c' };
    const at = (iso: string) => new Date(iso);
    const seed: Array<[string, 'rpc' | 'a11y' | 'visual', 'succeeded' | 'failed', string]> = [
      ['00000000-0000-4000-8000-000000000001', 'rpc', 'succeeded', '2026-06-01T10:00:00Z'],
      ['00000000-0000-4000-8000-000000000002', 'a11y', 'failed', '2026-06-02T10:00:00Z'],
      ['00000000-0000-4000-8000-000000000003', 'a11y', 'succeeded', '2026-06-03T10:00:00Z'],
      ['00000000-0000-4000-8000-000000000004', 'visual', 'succeeded', '2026-06-03T10:00:00Z'],
      ['00000000-0000-4000-8000-000000000005', 'rpc', 'failed', '2026-06-03T10:00:00Z'],
      ['00000000-0000-4000-8000-000000000006', 'rpc', 'succeeded', '2026-06-04T10:00:00Z'],
      ['00000000-0000-4000-8000-000000000007', 'a11y', 'succeeded', '2026-06-05T10:00:00Z'],
    ];
    beforeAll(async () => {
      for (const [id, kind, status, created] of seed) {
        await sql`insert into runs (id, org_id, kind, status, summary, started_at, finished_at, created_at)
          values (${id}, 'org-c', ${kind}, ${status}, ${kind}, ${at(created)}, ${at(created)}, ${at(created)})`.execute(
          db,
        );
      }
      // In flight: not a finished run, never listed.
      await sql`insert into runs (org_id, kind, status, summary, started_at, created_at)
        values ('org-c', 'a11y', 'running', 'job', now(), now())`.execute(db);
    });
    const ids = (runs: Array<{ id: string }>) => runs.map((r) => r.id.slice(-1));

    it('pages newest first without gaps or repeats, ties broken by id', async () => {
      const store = history().forOrg(C);
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await store.listPage({ limit: 2, cursor });
        seen.push(...ids(page.runs));
        cursor = page.nextCursor ?? undefined;
        pages++;
      } while (cursor);
      expect(seen).toEqual(['7', '6', '5', '4', '3', '2', '1']);
      expect(pages).toBe(4);
    });

    it('filters by kind, status and created date, combined with paging', async () => {
      const store = history().forOrg(C);
      expect(ids((await store.listPage({ kind: 'a11y' })).runs)).toEqual(['7', '3', '2']);
      expect(ids((await store.listPage({ status: 'failed' })).runs)).toEqual(['5', '2']);
      expect(
        ids(
          (
            await store.listPage({
              from: at('2026-06-02T00:00:00Z'),
              to: at('2026-06-04T00:00:00Z'),
            })
          ).runs,
        ),
      ).toEqual(['5', '4', '3', '2']);
      const first = await store.listPage({ kind: 'rpc', limit: 1 });
      expect(ids(first.runs)).toEqual(['6']);
      const next = await store.listPage({ kind: 'rpc', limit: 1, cursor: first.nextCursor! });
      expect(ids(next.runs)).toEqual(['5']);
    });

    it('is scoped to the org, a cursor included, and refuses a malformed cursor', async () => {
      const page = await history().forOrg(C).listPage({ limit: 3 });
      // Another org's store with org C's cursor still reads only its own runs.
      const other = await history().forOrg(A).listPage({ cursor: page.nextCursor! });
      expect(other.runs.every((r) => !r.id.startsWith('00000000-0000-4000-8000'))).toBe(true);
      await expect(history().forOrg(C).listPage({ cursor: 'not-a-cursor' })).rejects.toThrow(
        InvalidCursorError,
      );
    });

    // Postgres keeps microseconds; a JS Date only milliseconds. A cursor built from a Date
    // would skip rows inside the same millisecond as a page boundary.
    it('pages exactly through rows microseconds apart', async () => {
      await sql`insert into organization (id, name, slug, "createdAt")
        values ('org-d', 'org-d', 'org-d', now())`.execute(db);
      for (const us of ['100', '200', '300', '400', '500']) {
        const ts = `2026-07-01 10:00:00.123${us}+00`;
        await sql`insert into runs (org_id, kind, status, summary, started_at, finished_at, created_at)
          values ('org-d', 'rpc', 'succeeded', ${us}, ${ts}::timestamptz, ${ts}::timestamptz, ${ts}::timestamptz)`.execute(
          db,
        );
      }
      const store = history().forOrg({ orgId: 'org-d' });
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await store.listPage({ limit: 2, cursor });
        seen.push(...page.runs.map((r) => r.summary));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(seen).toEqual(['500', '400', '300', '200', '100']);
    });

    it('has no next cursor on the last page', async () => {
      expect((await history().forOrg(C).listPage({ limit: 50 })).nextCursor).toBeNull();
    });
  });
});
