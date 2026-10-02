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
  /** @returns the new run's id */
  record(run: RunInput): Promise<string>;
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
            action: describeAction(action),
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
      async record(run) {
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
                  sql`(${orgId}, ${runId}, ${position}, ${r.url}, ${r.passed}, ${JSON.stringify(r.result)}::jsonb)`,
              );
              await sql`
                insert into run_results (org_id, run_id, position, url, passed, result)
                values ${sql.join(values)}`.execute(tx);
            }
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
          where org_id = ${orgId} order by created_at desc, id limit ${limit}`.execute(db);
        return rows.map(toStoredRun);
      },

      async get(id) {
        // Not a uuid is not a run here; Postgres would reject the cast instead.
        if (!UUID.test(id)) return null;
        const { rows } = await sql<RunRow>`
          select id, kind, status, summary, started_at, finished_at, created_at from runs
          where org_id = ${orgId} and id = ${id}`.execute(db);
        if (!rows[0]) return null;
        const results = await sql<StoredRunResult>`
          select url, passed, result from run_results
          where org_id = ${orgId} and run_id = ${id} order by position`.execute(db);
        return { ...toStoredRun(rows[0]), results: results.rows };
      },
    }),
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
