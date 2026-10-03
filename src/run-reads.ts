import { sql, type Kysely } from 'kysely';

/**
 * Reading an org's finished runs (#269, #270), with no dependency beyond Kysely: the
 * portal imports this, and must not pull in the runners (Playwright) that the write
 * side of `history-store` needs. `postgresHistory().forOrg()` uses the same functions.
 */

export type RunKind = 'rpc' | 'a11y' | 'visual';

export interface StoredRun {
  id: string;
  kind: RunKind;
  status: 'succeeded' | 'failed';
  /** `null` for a job that could not run (it has an `error` instead). */
  summary: string | null;
  startedAt: Date;
  finishedAt: Date;
  createdAt: Date;
}

/** One page, comparison or action of a run. `url` is the page it concerns, if any. */
export interface StoredRunResult {
  url: string | null;
  passed: boolean;
  result: Record<string, unknown>;
}

/** Filters and position for one page of an org's runs (#269). */
export interface RunPageQuery {
  /** 1-100; default 50. */
  limit?: number;
  kind?: RunKind;
  status?: StoredRun['status'] | 'canceled';
  /** `finished_at >= from`. */
  from?: Date;
  /** `finished_at < to`. */
  to?: Date;
  /** The previous page's `nextCursor`. */
  cursor?: string;
}

export interface RunPage {
  runs: StoredRun[];
  /** Pass back as `cursor` for the next page; `null` on the last one. */
  nextCursor: string | null;
}

/** A `cursor` this store did not issue (or garbled): the API answers 400. */
export class InvalidCursorError extends Error {
  constructor() {
    super('Invalid cursor');
    this.name = 'InvalidCursorError';
  }
}

/**
 * Opaque to clients: base64url of `<finished_at>|<id>`, the time as microsecond UTC ISO
 * text from Postgres's `to_char` (a JS Date keeps milliseconds, and `::text` follows the
 * server's DateStyle and TimeZone). Rows inside one millisecond still page exactly.
 */
const encodeCursor = (finishedIso: string, id: string) =>
  Buffer.from(`${finishedIso}|${id}`).toString('base64url');

const UTC_MICROS = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)\.\d{6}Z$/;

function decodeCursor(cursor: string): { finishedIso: string; id: string } {
  const [finishedIso, id, extra] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const m = UTC_MICROS.exec(finishedIso ?? '');
  // The shape alone lets `2026-99-99` through to Postgres, which then fails the cast (500):
  // a real time survives a round trip through Date unchanged.
  const parsed = m ? new Date(`${m[1]}Z`) : null;
  const real =
    m && parsed && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 19) === m[1];
  if (extra !== undefined || !id || !UUID.test(id) || !real) throw new InvalidCursorError();
  return { finishedIso, id };
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RunRow {
  id: string;
  kind: RunKind;
  status: 'succeeded' | 'failed';
  summary: string;
  started_at: Date;
  finished_at: Date;
  created_at: Date;
}

export const toStoredRun = (row: RunRow): StoredRun => ({
  id: row.id,
  kind: row.kind,
  status: row.status,
  summary: row.summary,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  createdAt: row.created_at,
});

/** An org's runs, read-only: every query is filtered by `orgId`. */
export function orgRunReads(db: Kysely<unknown>, orgId: string) {
  return {
    /**
     * Newest first by finish time, keyset-paged on (finished_at, id); finished runs only.
     * Finish time, not creation: a job is created when queued, and one that finished after
     * a client's cursor passed its creation time would never appear on any page.
     */
    async listPage({
      limit = 50,
      kind,
      status,
      from,
      to,
      cursor,
    }: RunPageQuery = {}): Promise<RunPage> {
      const after = cursor === undefined ? null : decodeCursor(cursor);
      const n = Math.min(Math.max(Math.trunc(limit), 1), 100);
      // One row more than the page: its presence is what says there is a next page.
      const { rows } = await sql<RunRow & { finished_iso: string }>`
        select id, kind, status, summary, started_at, finished_at, created_at,
               to_char(finished_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                 as finished_iso
        from runs
        where org_id = ${orgId} and finished_at is not null
          ${kind ? sql`and kind = ${kind}` : sql``}
          ${status ? sql`and status = ${status}` : sql``}
          ${from ? sql`and finished_at >= ${from}` : sql``}
          ${to ? sql`and finished_at < ${to}` : sql``}
          ${after ? sql`and (finished_at, id) < (${after.finishedIso}::timestamptz, ${after.id}::uuid)` : sql``}
        order by finished_at desc, id desc limit ${n + 1}`.execute(db);
      const last = rows.length > n ? rows[n - 1] : null;
      return {
        runs: rows.slice(0, n).map(toStoredRun),
        nextCursor: last ? encodeCursor(last.finished_iso, last.id) : null,
      };
    },

    /** `null` for another org's run, an unknown id or a non-uuid. */
    /**
     * `error` says why a job could not run (it then has no summary and no results): without
     * it, a failed job's detail would be a dead end.
     */
    async get(
      id: string,
    ): Promise<(StoredRun & { error: string | null; results: StoredRunResult[] }) | null> {
      // Not a uuid is not a run here; Postgres would reject the cast instead.
      if (!UUID.test(id)) return null;
      const { rows } = await sql<RunRow & { error: string | null }>`
        select id, kind, status, summary, started_at, finished_at, created_at, error from runs
        where org_id = ${orgId} and id = ${id} and finished_at is not null`.execute(db);
      if (!rows[0]) return null;
      const results = await sql<StoredRunResult>`
        select url, passed, result from run_results
        where org_id = ${orgId} and run_id = ${id} order by position`.execute(db);
      return { ...toStoredRun(rows[0]), error: rows[0].error, results: results.rows };
    },
  };
}
