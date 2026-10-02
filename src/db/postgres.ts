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
 *
 * `queryTimeoutMs` also bounds each query, for callers on a request path (#341):
 * the server cancels a slow statement, and the client gives up on a connection
 * that stopped answering mid-query, which the connect timeout does not cover.
 * Unset by default, because a migration may legitimately run long.
 */
export function createPostgresDb<DB = unknown>(
  connectionString: string,
  options: { queryTimeoutMs?: number } = {},
): Kysely<DB> {
  const { queryTimeoutMs } = options;
  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 10_000,
    ...(queryTimeoutMs && {
      statement_timeout: queryTimeoutMs,
      // A little later than the server's own cancel, so a live server answers first.
      query_timeout: queryTimeoutMs + 1_000,
    }),
  });
  // An idle connection the server ends (a restart, an admin kill) is reported here
  // and dropped from the pool, which opens a new one on the next query. Without a
  // listener, `pg`'s 'error' event is an uncaught exception that takes the process
  // down (#341: the hosted RPC server exited when Postgres restarted).
  pool.on('error', (err) => {
    console.error(`[iris] idle Postgres connection lost; the pool replaces it: ${err.message}`);
  });
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}
