import { type Kysely, sql } from 'kysely';

/**
 * BetterAuth's rate-limit table (#316): the portal keeps its auth counters in the
 * database (`rateLimit.storage: 'database'`), so the two portal processes of a rolling
 * deploy share one counter per client and path instead of each counting alone. The
 * table BetterAuth's generator emits for that option (its `rateLimit` model: key unique,
 * count, lastRequest as epoch milliseconds), in its own names, like 0001.
 * `postgres.test.ts` asks BetterAuth whether the migrated schema still lacks anything.
 * The previous release keeps counting in memory and never reads it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create table "rateLimit" ("id" text not null primary key, "key" text not null unique, "count" integer not null, "lastRequest" bigint not null)`.execute(
    db,
  );
}
