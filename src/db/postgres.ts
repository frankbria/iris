import * as fs from 'fs';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

/**
 * The hosted database URL (#248, ADR 0001 §2): `DATABASE_URL`, or
 * `DATABASE_URL_FILE` naming a file that holds it. The file is the deployed
 * form, like `IRIS_CONNECT_TOKEN_FILE`: the URL carries the password, and an
 * environment variable is visible to `docker inspect`.
 *
 * @throws when neither or both are set, or the file is empty
 */
export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const { DATABASE_URL: url, DATABASE_URL_FILE: file } = env;
  if (url && file)
    throw new Error('Set DATABASE_URL and DATABASE_URL_FILE one at a time, not both');
  if (url) return url;
  if (!file) throw new Error('Set DATABASE_URL (or DATABASE_URL_FILE) to a Postgres URL');
  const fromFile = fs.readFileSync(file, 'utf8').trim();
  if (!fromFile) throw new Error(`DATABASE_URL_FILE ${file} is empty`);
  return fromFile;
}

/**
 * A Kysely instance over a `pg` pool. The caller owns it: `destroy()` ends the pool.
 *
 * `pg` waits forever for a server that accepts and never answers, so a deploy's
 * migration step against a blackholed host would hang instead of failing.
 */
export function createPostgresDb<DB = unknown>(connectionString: string): Kysely<DB> {
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 10_000 });
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}
