/**
 * Terms acceptance (#276): sign-up is refused without the current versions, stores one
 * row per document with version, time and address when it has them, and a user missing
 * the current versions is found (re-acceptance).
 *
 * Test strategy: a real Postgres (throwaway database) and BetterAuth's server API
 * through one spawned Node (BetterAuth is ESM-only; Jest cannot load it, see
 * auth-org.test.ts). The acceptance helpers use only Kysely, so they run in-process.
 */

import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { Client } from 'pg';
import { sql } from 'kysely';
import { hasAcceptedCurrent, recordCurrentAcceptance } from '../src/legal/acceptance';
import { createPostgresDb } from '../src/db/postgres';
import { migrateToLatest } from '../src/db/migrate';
import { ACCEPTED_TERMS, LEGAL_VERSIONS } from '../src/legal/versions';

const ADMIN_URL = process.env.IRIS_TEST_DATABASE_URL;
const REPO_ROOT = path.resolve(__dirname, '..');

if (!ADMIN_URL) {
  if (process.env.CI) throw new Error('IRIS_TEST_DATABASE_URL is required in CI');
  console.warn('Skipping terms tests: set IRIS_TEST_DATABASE_URL (see docker-compose.dev.yml)');
}

const PROBE = `
const { Pool } = require('pg');
const { createAuth } = require('./src/auth/config.ts');
const { ACCEPTED_TERMS } = require('./src/legal/versions.ts');
(async () => {
  const pool = new Pool({ connectionString: process.env.PROBE_URL });
  const auth = createAuth({
    secret: process.env.PROBE_SECRET,
    baseURL: 'https://portal.example.com',
    database: pool,
    sendEmail: async () => {},
  });
  const attempt = (body, headers) =>
    auth.api.signUpEmail({ body: { password: 'correct-horse-battery-staple', name: 'T', ...body }, headers })
      .then(() => 'ok', (e) => (e.body && e.body.code) || e.status || String(e));
  const r = {};
  r.none = await attempt({ email: 'none@iris.test' });
  r.stale = await attempt({ email: 'stale@iris.test', acceptedTerms: '2000-01-01:2000-01-01' });
  r.half = await attempt({ email: 'half@iris.test', acceptedTerms: ACCEPTED_TERMS.split(':')[0] });
  r.ok = await attempt({ email: 'ok@iris.test', acceptedTerms: ACCEPTED_TERMS },
    new Headers({ 'x-real-ip': '203.0.113.9' }));
  // The same address again: BetterAuth answers as if it were new.
  r.dup = await attempt({ email: 'ok@iris.test', acceptedTerms: ACCEPTED_TERMS });
  await pool.end();
  process.stdout.write(JSON.stringify(r));
})().catch((e) => { console.error(e); process.exit(1); });
`;

(ADMIN_URL ? describe : describe.skip)('terms acceptance', () => {
  const dbName = `iris_terms_${process.pid}_${randomBytes(4).toString('hex')}`;
  let url: string;
  let r: Record<string, string>;
  let probeStderr = '';

  async function admin(query: string): Promise<void> {
    const client = new Client({ connectionString: ADMIN_URL });
    await client.connect();
    try {
      await client.query(query);
    } finally {
      await client.end();
    }
  }
  const rowsFor = async (email: string) => {
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      return (
        await client.query(
          `select a.document, a.version, a.accepted_at, a.ip, u.email from terms_acceptances a
           join "user" u on u.id = a.user_id where u.email = $1 order by a.document`,
          [email],
        )
      ).rows;
    } finally {
      await client.end();
    }
  };

  beforeAll(async () => {
    await admin(`CREATE DATABASE "${dbName}"`);
    const u = new URL(ADMIN_URL!);
    u.pathname = `/${dbName}`;
    url = u.toString();
    const db = createPostgresDb(url);
    try {
      await migrateToLatest(db);
    } finally {
      await db.destroy();
    }
    const { stdout, stderr } = await promisify(execFile)(
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
    r = JSON.parse(stdout);
    probeStderr = stderr;
  }, 60_000);

  afterAll(async () => {
    await admin(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  });

  it('refuses a sign-up without acceptance, with an old version, or with half of it', async () => {
    expect(r.none).toBe('TERMS_NOT_ACCEPTED');
    expect(r.stale).toBe('TERMS_NOT_ACCEPTED');
    expect(r.half).toBe('TERMS_NOT_ACCEPTED');
    // Refused before the user exists: nothing was created.
    for (const email of ['none', 'stale', 'half'])
      expect(await rowsFor(`${email}@iris.test`)).toEqual([]);
    const client = new Client({ connectionString: url });
    await client.connect();
    const users = await client.query(`select email from "user" order by email`);
    await client.end();
    expect(users.rows.map((u) => u.email)).toEqual(['ok@iris.test']);
  });

  it('stores one row per document with version, time and address', async () => {
    expect(r.ok).toBe('ok');
    const rows = await rowsFor('ok@iris.test');
    expect(rows.map((x) => [x.document, x.version, x.ip])).toEqual([
      ['acceptable-use', LEGAL_VERSIONS['acceptable-use'], '203.0.113.9'],
      ['terms', LEGAL_VERSIONS.terms, '203.0.113.9'],
    ]);
    expect(Math.abs(Date.now() - new Date(rows[0].accepted_at).getTime())).toBeLessThan(120_000);
  });

  it('a duplicate-email sign-up writes no rows, logs no error, and answers as before', async () => {
    expect(r.dup).toBe('ok');
    expect(probeStderr).not.toMatch(/terms acceptance|foreign key/i);
    expect(await rowsFor('ok@iris.test')).toHaveLength(2);
    const client = new Client({ connectionString: url });
    await client.connect();
    const n = await client.query('select count(*)::int as n from terms_acceptances');
    await client.end();
    expect(n.rows[0].n).toBe(2);
  });

  it('finds a user who has not accepted the current versions, and records the re-acceptance', async () => {
    const db = createPostgresDb(url);
    try {
      const { rows } = await sql<{ id: string }>`
        select id from "user" where email = 'ok@iris.test'`.execute(db);
      const id = rows[0].id;
      expect(await hasAcceptedCurrent(db, id)).toBe(true);

      // A version bump: the user's rows are for older versions only.
      await sql`update terms_acceptances set version = '2000-01-01' where user_id = ${id}`.execute(
        db,
      );
      expect(await hasAcceptedCurrent(db, id)).toBe(false);

      await recordCurrentAcceptance(db, id, '198.51.100.4');
      await recordCurrentAcceptance(db, id, '198.51.100.5'); // a repeat adds nothing
      expect(await hasAcceptedCurrent(db, id)).toBe(true);
      const all = await sql<{ version: string; ip: string }>`
        select version, ip from terms_acceptances where user_id = ${id}
        order by version, document`.execute(db);
      // History is kept: the old rows stay beside the new ones, first address wins.
      expect(all.rows.map((x) => x.version)).toEqual([
        '2000-01-01',
        '2000-01-01',
        LEGAL_VERSIONS['acceptable-use'],
        LEGAL_VERSIONS.terms,
      ]);
      expect(all.rows.at(-1)!.ip).toBe('198.51.100.4');
    } finally {
      await db.destroy();
    }
  });
});

describe('legal versions', () => {
  // The constant is what is enforced; the file is what a person reads. They must agree.
  it.each(['terms', 'acceptable-use'] as const)('%s.md carries the enforced version', (name) => {
    const file = fs.readFileSync(
      path.join(REPO_ROOT, 'apps/portal/content/legal', `${name}.md`),
      'utf8',
    );
    expect(file).toMatch(new RegExp(`^---\\n[\\s\\S]*?\\nversion: ${LEGAL_VERSIONS[name]}\\n`));
  });

  it('the sign-up token names both versions', () => {
    expect(ACCEPTED_TERMS).toBe(`${LEGAL_VERSIONS.terms}:${LEGAL_VERSIONS['acceptable-use']}`);
  });
});
