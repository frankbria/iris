import type Database from 'better-sqlite3';
import { sql, type Kysely } from 'kysely';
import { describeAction } from './actions';
import { calculateAccessibilityScore } from './a11y/a11y-runner';
import type { AccessibilityTestResult } from './a11y/a11y-runner';
import {
  getA11yTestResults,
  getTestRuns,
  getVisualTestResults,
  initializeDatabase,
  insertA11yTestResult,
  insertTestRun,
  insertVisualTestResult,
} from './db';
import type { ExecutionResult } from './executor';
import { insertUsage, type UsageEvent } from './billing/usage';
import type { VisualTestResult as VisualRunResult } from './visual/visual-runner';

/**
 * Run history behind one seam (#254): SQLite for local mode, Postgres keyed by
 * org for the hosted service (ADR 0001 §2).
 */

export type RunKind = 'rpc' | 'a11y' | 'visual';

/** A finished run, as the code that ran it has it. Each store maps it to its tables. */
export type RunInput = { startedAt: Date; finishedAt: Date } & (
  | { kind: 'visual'; result: VisualRunResult }
  | { kind: 'a11y'; result: AccessibilityTestResult }
  /** One `executeBrowserAction` request: its actions, in order. */
  | { kind: 'rpc'; success: boolean; results: ExecutionResult[] }
);

export interface StoredRun {
  id: string;
  kind: RunKind;
  status: 'succeeded' | 'failed';
  summary: string;
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

export interface HistoryStore {
  /**
   * @param options.usage - billable usage of the run (#263), written in the same
   *   transaction as the run, so a run is never recorded without its usage or the
   *   other way round. Hosted only; the local store ignores it.
   * @returns the new run's id
   */
  record(run: RunInput, options?: { usage?: UsageEvent[] }): Promise<string>;
  /** Newest first. */
  list(options?: { limit?: number }): Promise<StoredRun[]>;
  /** `null` for an id this store does not hold. */
  get(id: string): Promise<(StoredRun & { results: StoredRunResult[] }) | null>;
}

/** The hosted history: reachable only per org. */
export interface PostgresHistory {
  forOrg(scope: TenantScope): HistoryStore;
}

/** Who a hosted run belongs to: the org, and the API key that started it, if any. */
export interface TenantScope {
  orgId: string;
  apiKeyId?: string;
}

function summarize(run: RunInput): { summary: string; passed: boolean } {
  switch (run.kind) {
    case 'visual':
      return {
        summary: `visual: ${run.result.summary.totalComparisons} comparison(s), ${run.result.summary.failed} failed`,
        passed: run.result.summary.overallStatus !== 'failed',
      };
    case 'a11y':
      return {
        summary: `a11y: ${run.result.summary.pagesTested} page(s), ${run.result.summary.totalViolations} violation(s)`,
        passed: run.result.summary.passed,
      };
    case 'rpc':
      return {
        summary: `rpc: ${run.results.length} action(s), ${run.results.filter((r) => !r.success).length} failed`,
        passed: run.success,
      };
  }
}

/** Violations per impact on one a11y page. */
function violationCounts(page: AccessibilityTestResult['results'][number]) {
  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const violation of page.axeResult.violations) {
    if (violation.impact && violation.impact in counts) {
      counts[violation.impact as keyof typeof counts] += 1;
    }
  }
  return counts;
}

/**
 * One result per page, comparison or action. An RPC action is stored as
 * `describeAction()`, which never includes what a `fill` typed (#81): history is
 * readable by everyone in the org, and a typed value is often a password.
 */
function resultsOf(run: RunInput): StoredRunResult[] {
  switch (run.kind) {
    case 'visual':
      return run.result.results.map((c) => ({
        url: c.page,
        passed: c.passed,
        result: {
          device: c.device,
          // A fraction: `pixelDifference` is a raw pixel count.
          diffPercentage: 1 - c.similarity,
          ...(c.severity && { severity: c.severity }),
        },
      }));
    case 'a11y':
      return run.result.results.map((page) => {
        const counts = violationCounts(page);
        return {
          url: page.page,
          passed: page.axeResult.violations.length === 0,
          result: {
            violations: counts,
            // Absent sub-tests mean "not run", which is not a failure to record.
            keyboardPassed: page.keyboardResult?.passed ?? true,
            screenReaderPassed: page.screenReaderResult?.passed ?? true,
            score: calculateAccessibilityScore(counts, 1),
          },
        };
      });
    case 'rpc':
      return run.results.map((r) => {
        const action =
          r.action.type === 'navigate'
            ? { ...r.action, url: withoutCredentials(r.action.url) }
            : r.action;
        return {
          url: action.type === 'navigate' ? action.url : null,
          passed: r.success,
          result: {
            action: stripUserinfo(describeAction(action)),
            // Bounded: an error message is page-influenced text of any length. It
            // also quotes URLs (guardedGoto, Playwright's goto), credentials and all.
            // Cut by code point: a cut inside a surrogate pair leaves a lone half,
            // which Postgres's json input rejects, losing the whole run.
            ...(r.error && { error: [...stripUserinfo(r.error)].slice(0, 500).join('') }),
          },
        };
      });
  }
}

/**
 * A result as jsonb input, with every string storable. A lone UTF-16 surrogate
 * (a client can send one as a JSON escape in a selector, and errors quote selectors)
 * survives JSON.stringify as an escape Postgres's jsonb input rejects, and the whole
 * run would be lost. It becomes U+FFFD instead.
 */
const toJsonb = (value: unknown) =>
  JSON.stringify(value, (_key, v: unknown) => (typeof v === 'string' ? wellFormed(v) : v));

/**
 * What Postgres cannot store, as U+FFFD: a lone surrogate (`toWellFormed()`, which
 * the ES2020 lib does not declare) and U+0000, which neither jsonb nor text accepts.
 */
const wellFormed = (text: string) => text.replace(UNSTORABLE, '\uFFFD');
const UNSTORABLE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|\u0000/g;

/** Every `scheme://user:password@` in free text, without the userinfo. */
const stripUserinfo = (text: string) => text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1');

/**
 * A URL without its `user:password@`: history is readable by everyone in the org.
 * ponytail: query-string tokens are kept; they are often what the page under test is.
 */
function withoutCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return url;
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RunRow {
  id: string;
  kind: RunKind;
  status: 'succeeded' | 'failed';
  summary: string;
  started_at: Date;
  finished_at: Date;
  created_at: Date;
}

const toStoredRun = (row: RunRow): StoredRun => ({
  id: row.id,
  kind: row.kind,
  status: row.status,
  summary: row.summary,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  createdAt: row.created_at,
});

/**
 * The hosted history (#254). The only way to a store is `forOrg(scope)`, and every
 * query it runs filters by that org, so no read path exists without a tenant. A
 * run's `api_key_id` is checked against its org by a foreign key (migration 0002).
 */
export function postgresHistory(db: Kysely<unknown>): PostgresHistory {
  return {
    forOrg: ({ orgId, apiKeyId }) => ({
      async record(run, { usage = [] } = {}) {
        const { summary, passed } = summarize(run);
        const results = resultsOf(run);
        // One transaction: a run is never visible without its results. `position`
        // keeps their order: every row of the transaction has the same created_at.
        const insert = (keyId: string | null) =>
          db.transaction().execute(async (tx) => {
            const { rows } = await sql<{ id: string }>`
              insert into runs (org_id, api_key_id, kind, status, summary, started_at, finished_at)
              values (${orgId}, ${keyId}, ${run.kind}, ${passed ? 'succeeded' : 'failed'},
                      ${summary}, ${run.startedAt}, ${run.finishedAt})
              returning id`.execute(tx);
            const runId = rows[0].id;
            if (results.length) {
              const values = results.map(
                (r, position) =>
                  sql`(${orgId}, ${runId}, ${position}, ${r.url === null ? null : wellFormed(r.url)}, ${r.passed}, ${toJsonb(r.result)}::jsonb)`,
              );
              await sql`
                insert into run_results (org_id, run_id, position, url, passed, result)
                values ${sql.join(values)}`.execute(tx);
            }
            await insertUsage(
              tx,
              orgId,
              usage.map((u) => ({ ...u, runId })),
            );
            return runId;
          });
        try {
          return await insert(apiKeyId ?? null);
        } catch (err) {
          // The key was revoked between authentication and this write (or is not
          // this org's). Keep the run, without a key: the state `on delete set null`
          // would have left it in a moment later.
          const e = err as { code?: string; constraint?: string };
          if (apiKeyId && e.code === '23503' && e.constraint === 'runs_org_id_api_key_id_fkey') {
            return insert(null);
          }
          throw err;
        }
      },

      async list({ limit = 50 } = {}) {
        const { rows } = await sql<RunRow>`
          select id, kind, status, summary, started_at, finished_at, created_at from runs
          where org_id = ${orgId} and finished_at is not null
          order by created_at desc, id limit ${limit}`.execute(db);
        return rows.map(toStoredRun);
      },

      async get(id) {
        // Not a uuid is not a run here; Postgres would reject the cast instead.
        if (!UUID.test(id)) return null;
        const { rows } = await sql<RunRow>`
          select id, kind, status, summary, started_at, finished_at, created_at from runs
          where org_id = ${orgId} and id = ${id} and finished_at is not null`.execute(db);
        if (!rows[0]) return null;
        const results = await sql<StoredRunResult>`
          select url, passed, result from run_results
          where org_id = ${orgId} and run_id = ${id} order by position`.execute(db);
        return { ...toStoredRun(rows[0]), results: results.rows };
      },
    }),
  };
}

// --- Jobs (#267): queued `runs` rows, claimed by a worker --------------------------

/** What a job runs, as the request stated it. */
export interface A11yJobParams {
  urls: string[];
  wcagLevel: 'A' | 'AA' | 'AAA';
  failOn: Array<'critical' | 'serious' | 'moderate' | 'minor'>;
}

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

/** A job as its org reads it: any status, results once finished. */
export interface StoredJob {
  id: string;
  kind: RunKind;
  status: JobStatus;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  summary: string | null;
  error: string | null;
  results: StoredRunResult[];
}

/** A claimed job: what the worker needs to run it and to write its outcome. */
export interface ClaimedJob {
  id: string;
  orgId: string;
  apiKeyId: string | null;
  kind: 'a11y';
  params: A11yJobParams;
  startedAt: Date;
  /** Which claim this is: only its holder may write the outcome (#435). */
  claimToken: string;
  /** How many times the job has been claimed, this claim included. */
  attempts: number;
}

/** The org-scoped half: what the API does for a tenant. */
export interface OrgJobs {
  /**
   * @param options.maxOutstanding - cap on this org's queued + running jobs, checked in
   *   the same transaction as the insert, so concurrent calls cannot exceed it
   * @returns the new job's id (status `queued`), or `null` when the org is at the cap
   */
  enqueue(
    job: { kind: 'a11y'; params: A11yJobParams },
    options?: { maxOutstanding?: number },
  ): Promise<string | null>;
  /** `null` for an id that is not this org's, or not a uuid. */
  get(id: string): Promise<StoredJob | null>;
}

/** The hosted job queue: `forOrg` for the API, the rest for workers (cross-tenant). */
export interface PostgresJobs {
  forOrg(scope: TenantScope): OrgJobs;
  /** The oldest queued job of a kind, now `running`; `null` when none. Safe to call concurrently. */
  claim(kind: 'a11y'): Promise<ClaimedJob | null>;
  /**
   * Writes the outcome of a claimed job: its results, its status (the run's verdict) and
   * its `a11y_job` usage, in one transaction. `status` stays `running` until this commits.
   * @returns `false`, having written nothing, when the claim was lost (the job was reaped, #435)
   */
  finish(job: ClaimedJob, result: AccessibilityTestResult): Promise<boolean>;
  /** The job could not run. No usage: nothing was delivered. `false` when the claim was lost. */
  fail(job: ClaimedJob, message: string): Promise<boolean>;
  /** Says the claim is alive. `false` when it was lost. */
  heartbeat(job: ClaimedJob): Promise<boolean>;
  /**
   * Takes back running jobs whose heartbeat is older than `staleMs`: requeued while they
   * have attempts left, otherwise failed. One statement, rows taken `SKIP LOCKED`, so
   * concurrent reapers and workers never process a job twice. A running row with no
   * heartbeat (claimed before migration 0005) is judged by its start time.
   */
  reapStuck(options?: { staleMs?: number; maxAttempts?: number }): Promise<ReapResult>;
}

export interface ReapResult {
  requeued: number;
  failed: number;
}

const JOB_ERROR_MAX = 500;

export function postgresJobs(db: Kysely<unknown>): PostgresJobs {
  return {
    forOrg: ({ orgId, apiKeyId }) => ({
      async enqueue({ kind, params }, { maxOutstanding = Infinity } = {}) {
        // One transaction under a per-org advisory lock: the count and the insert
        // cannot interleave with another enqueue of the same org.
        const attempt = (keyId: string | null) =>
          db.transaction().execute(async (tx) => {
            await sql`select pg_advisory_xact_lock(hashtext(${orgId}))`.execute(tx);
            if (Number.isFinite(maxOutstanding)) {
              const { rows } = await sql<{ n: string }>`
                select count(*) as n from runs
                where org_id = ${orgId} and status in ('queued', 'running')`.execute(tx);
              if (Number(rows[0].n) >= maxOutstanding) return null;
            }
            const { rows } = await sql<{ id: string }>`
              insert into runs (org_id, api_key_id, kind, status, params)
              values (${orgId}, ${keyId}, ${kind}, 'queued', ${toJsonb(params)}::jsonb)
              returning id`.execute(tx);
            return rows[0].id;
          });
        try {
          return await attempt(apiKeyId ?? null);
        } catch (err) {
          // The key was revoked after authentication: keep the job, as `record` does.
          const e = err as { code?: string; constraint?: string };
          if (apiKeyId && e.code === '23503' && e.constraint === 'runs_org_id_api_key_id_fkey') {
            return attempt(null);
          }
          throw err;
        }
      },

      async get(id) {
        if (!UUID.test(id)) return null;
        const { rows } = await sql<
          Omit<RunRow, 'status' | 'started_at' | 'finished_at'> & {
            status: JobStatus;
            started_at: Date | null;
            finished_at: Date | null;
            error: string | null;
            summary: string | null;
          }
        >`select id, kind, status, summary, error, started_at, finished_at, created_at from runs
          where org_id = ${orgId} and id = ${id}`.execute(db);
        const row = rows[0];
        if (!row) return null;
        const results = await sql<StoredRunResult>`
          select url, passed, result from run_results
          where org_id = ${orgId} and run_id = ${id} order by position`.execute(db);
        return {
          id: row.id,
          kind: row.kind,
          status: row.status,
          createdAt: row.created_at,
          startedAt: row.started_at,
          finishedAt: row.finished_at,
          summary: row.summary,
          error: row.error,
          results: results.rows,
        };
      },
    }),

    async claim(kind) {
      // SKIP LOCKED: concurrent workers take different rows instead of queueing on one.
      const { rows } = await sql<{
        id: string;
        org_id: string;
        api_key_id: string | null;
        params: A11yJobParams;
        started_at: Date;
        claim_token: string;
        attempts: number;
      }>`
        update runs set status = 'running', started_at = now(), attempts = attempts + 1,
               claim_token = gen_random_uuid(), heartbeat_at = now()
        where id = (select id from runs where status = 'queued' and kind = ${kind}
                    order by created_at, id for update skip locked limit 1)
        returning id, org_id, api_key_id, params, started_at, claim_token, attempts`.execute(db);
      const row = rows[0];
      return row
        ? {
            id: row.id,
            orgId: row.org_id,
            apiKeyId: row.api_key_id,
            kind,
            params: row.params,
            startedAt: row.started_at,
            claimToken: row.claim_token,
            attempts: row.attempts,
          }
        : null;
    },

    async finish(job, result) {
      const finishedAt = new Date();
      const run: RunInput = { kind: 'a11y', result, startedAt: job.startedAt, finishedAt };
      const { summary, passed } = summarize(run);
      const results = resultsOf(run);
      return db.transaction().execute(async (tx) => {
        const updated = await sql`
          update runs set status = ${passed ? 'succeeded' : 'failed'}, summary = ${summary},
                 finished_at = ${finishedAt}
          where id = ${job.id} and org_id = ${job.orgId} and status = 'running'
                and claim_token = ${job.claimToken}`.execute(tx);
        if (!updated.numAffectedRows) return false; // reaped: the new claim owns the outcome
        if (results.length) {
          const values = results.map(
            (r, position) =>
              sql`(${job.orgId}, ${job.id}, ${position}, ${r.url === null ? null : wellFormed(r.url)}, ${r.passed}, ${toJsonb(r.result)}::jsonb)`,
          );
          await sql`
            insert into run_results (org_id, run_id, position, url, passed, result)
            values ${sql.join(values)}`.execute(tx);
        }
        await insertUsage(tx, job.orgId, [
          { kind: 'a11y_job', quantity: 1, idempotencyKey: `job:${job.id}`, runId: job.id },
        ]);
        return true;
      });
    },

    async fail(job, message) {
      // Cut by code point, like an action error: the text may quote the page.
      const error = [...stripUserinfo(wellFormed(message))].slice(0, JOB_ERROR_MAX).join('');
      const updated = await sql`
        update runs set status = 'failed', error = ${error}, finished_at = now()
        where id = ${job.id} and org_id = ${job.orgId} and status = 'running'
              and claim_token = ${job.claimToken}`.execute(db);
      return Boolean(updated.numAffectedRows);
    },

    async heartbeat(job) {
      const updated = await sql`
        update runs set heartbeat_at = now()
        where id = ${job.id} and org_id = ${job.orgId} and status = 'running'
              and claim_token = ${job.claimToken}`.execute(db);
      return Boolean(updated.numAffectedRows);
    },

    // staleMs: the worker passes its DEFAULT_STALE_MS (src/worker.ts); this default matches it.
    async reapStuck({ staleMs = 180_000, maxAttempts = 3 } = {}) {
      const { rows } = await sql<{ status: string; n: string }>`
        with stale as (
          select id, attempts < ${maxAttempts} as retry from runs
          where status = 'running'
            and (heartbeat_at < now() - make_interval(secs => ${staleMs / 1000})
              or (heartbeat_at is null
                  and started_at < now() - make_interval(secs => ${staleMs / 1000})))
          for update skip locked
        ), reaped as (
          update runs r set
            status = case when s.retry then 'queued' else 'failed' end,
            started_at = case when s.retry then null else r.started_at end,
            finished_at = case when s.retry then null else now() end,
            error = case when s.retry then r.error else 'The job was interrupted too many times' end,
            claim_token = null, heartbeat_at = null
          from stale s where r.id = s.id
          returning r.status
        )
        select status, count(*) as n from reaped group by status`.execute(db);
      const count = (status: string) => Number(rows.find((r) => r.status === status)?.n ?? 0);
      return { requeued: count('queued'), failed: count('failed') };
    },
  };
}

/**
 * Runner severities are minor/moderate/breaking; the SQLite table stores the
 * low/medium/high/critical scale. `high` is unreachable from this direction.
 */
function toStoredSeverity(
  severity: 'minor' | 'moderate' | 'breaking' | undefined,
): 'low' | 'medium' | 'critical' | null {
  switch (severity) {
    case 'minor':
      return 'low';
    case 'moderate':
      return 'medium';
    case 'breaking':
      return 'critical';
    default:
      return null;
  }
}

/**
 * Writes a run to the local SQLite history (#77): one `test_results` row, plus the
 * per-comparison or per-page rows of its kind. Synchronous, like better-sqlite3.
 */
export function recordSqliteRun(db: Database.Database, run: RunInput): number {
  const { summary, passed } = summarize(run);
  const testRunId = insertTestRun(db, {
    instruction: summary,
    status: passed ? 'success' : 'error',
    startTime: run.startedAt,
    endTime: run.finishedAt,
  });
  if (run.kind === 'visual') {
    for (const c of run.result.results) {
      insertVisualTestResult(db, {
        testRunId,
        page: c.page,
        device: c.device,
        baselineRef: c.baselinePath ?? null,
        currentRef: c.screenshotPath,
        diffRef: c.diffPath ?? null,
        diffPercentage: 1 - c.similarity,
        aiAnalysis: c.aiAnalysis ? JSON.stringify(c.aiAnalysis) : null,
        severity: toStoredSeverity(c.severity),
        status: c.passed ? 'passed' : 'failed',
        timestamp: run.finishedAt,
      });
    }
  } else if (run.kind === 'a11y') {
    const stored = resultsOf(run);
    for (const [i, page] of run.result.results.entries()) {
      const { result } = stored[i];
      const counts = violationCounts(page);
      insertA11yTestResult(db, {
        testRunId,
        page: page.page,
        violationsCritical: counts.critical,
        violationsSerious: counts.serious,
        violationsModerate: counts.moderate,
        violationsMinor: counts.minor,
        keyboardPassed: result.keyboardPassed as boolean,
        screenReaderPassed: result.screenReaderPassed as boolean,
        // Scored per page against its own violations.
        score: result.score as number,
        status: page.axeResult.violations.length > 0 ? 'failed' : 'passed',
        timestamp: run.finishedAt,
      });
    }
  }
  return testRunId;
}

// The exact shape summarize() writes, so a user's own instruction for `iris run`
// that starts with "visual: " is not taken for a run.
const SUMMARY_KIND =
  /^(rpc|a11y|visual): \d+ (?:action|page|comparison)\(s\), \d+ (?:failed|violation\(s\))$/;

/** In the order they ran: the db.ts getters return newest first by `created_at`. */
const sortById = <T extends { id?: number }>(rows: T[]) =>
  [...rows].sort((x, y) => (x.id ?? 0) - (y.id ?? 0));

/**
 * The local history as a `HistoryStore` (#254). Local mode has one tenant, so there
 * is no scope. `test_results` has no kind column: a run's kind is the prefix of its
 * summary, and rows `iris run` and `iris watch` write (other summaries) are not runs
 * of this store.
 */
export function sqliteHistoryStore(dbPath: string): HistoryStore {
  const withDb = <T>(use: (db: Database.Database) => T): T => {
    const db = initializeDatabase(dbPath);
    try {
      return use(db);
    } finally {
      db.close();
    }
  };
  const toRun = (row: ReturnType<typeof getTestRuns>[number]): StoredRun | null => {
    const kind = SUMMARY_KIND.exec(row.instruction)?.[1] as RunKind | undefined;
    if (!kind) return null;
    return {
      id: String(row.id),
      kind,
      status: row.status === 'success' ? 'succeeded' : 'failed',
      summary: row.instruction,
      startedAt: row.startTime,
      finishedAt: row.endTime ?? row.startTime,
      createdAt: row.startTime,
    };
  };
  return {
    async record(run) {
      return String(withDb((db) => recordSqliteRun(db, run)));
    },
    async list({ limit = 50 } = {}) {
      return withDb((db) =>
        getTestRuns(db)
          .map(toRun)
          .filter((r): r is StoredRun => r !== null)
          // Newest first by insertion order: `created_at` has one-second resolution.
          .sort((x, y) => Number(y.id) - Number(x.id))
          .slice(0, limit),
      );
    },
    async get(id) {
      return withDb((db) => {
        const row = getTestRuns(db).find((r) => String(r.id) === id);
        const run = row && toRun(row);
        if (!run) return null;
        const testRunId = Number(id);
        const results: StoredRunResult[] =
          run.kind === 'visual'
            ? sortById(getVisualTestResults(db, { testRunId })).map((v) => ({
                url: v.page,
                passed: v.status === 'passed',
                result: {
                  device: v.device,
                  diffPercentage: v.diffPercentage,
                  ...(v.severity && { severity: v.severity }),
                },
              }))
            : run.kind === 'a11y'
              ? sortById(getA11yTestResults(db, { testRunId })).map((a) => ({
                  url: a.page,
                  passed: a.status === 'passed',
                  result: {
                    violations: {
                      critical: a.violationsCritical,
                      serious: a.violationsSerious,
                      moderate: a.violationsModerate,
                      minor: a.violationsMinor,
                    },
                    keyboardPassed: a.keyboardPassed,
                    screenReaderPassed: a.screenReaderPassed,
                    score: a.score,
                  },
                }))
              : [];
        return { ...run, results };
      });
    },
  };
}
