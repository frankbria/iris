import * as fs from 'fs';
import type { A11yJobParams, ClaimedJob, PostgresJobs } from './history-store';

/**
 * The hosted job worker (#267, ADR 0001 §1): claims queued jobs from Postgres and
 * runs them. Same image as `iris connect`, another command. Runs under IRIS_HOSTED,
 * so the runner's browser goes through the egress proxy and its pages through the
 * hosted URL policy.
 */

/**
 * A running job with no heartbeat for this long is reaped (#435): six missed 30 s beats.
 * Kept here, not imported from the store: a runtime import of it would load the store's
 * dependencies into every worker test (measured: it made a timing test flaky).
 */
export const DEFAULT_STALE_MS = 180_000;

export type WorkerJobs = Pick<
  PostgresJobs,
  'claim' | 'finish' | 'fail' | 'heartbeat' | 'reapStuck'
>;

/** The axe tags of a WCAG level: each level includes the ones below, like `--tags`. */
export function axeTagsFor(level: A11yJobParams['wcagLevel']): string[] {
  return ['wcag2a', 'wcag2aa', 'wcag2aaa'].slice(0, { A: 1, AA: 2, AAA: 3 }[level]);
}

/** Runs one job's scan. The defaults are `iris a11y`'s: axe plus keyboard tests, no report file. */
async function runA11y(params: A11yJobParams) {
  const { AccessibilityRunner } = await import('./a11y/a11y-runner');
  return new AccessibilityRunner({
    pages: params.urls,
    axe: {
      rules: {},
      tags: axeTagsFor(params.wcagLevel),
      include: [],
      exclude: [],
      disableRules: [],
      timeout: 30000,
    },
    keyboard: {
      testFocusOrder: true,
      testTrapDetection: true,
      testArrowKeyNavigation: true,
      testEscapeHandling: true,
      customSequences: [],
    },
    screenReader: {
      testAriaLabels: false,
      testLandmarkNavigation: false,
      testImageAltText: false,
      testHeadingStructure: false,
      simulateScreenReader: false,
    },
    failureThreshold: Object.fromEntries(params.failOn.map((impact) => [impact, true])),
    failOnHttpError: true,
    // No `output`: the result is stored, not written to the worker's disk.
  }).run();
}

/**
 * Claims and runs one job. While it runs, a timer (every `heartbeatMs`) tells the
 * database the claim is alive; a job whose heartbeat stops is reaped (#435). A failed
 * heartbeat write is logged and never stops the job.
 * @returns the job, or `null` when the queue was empty
 * @throws only when the database cannot be written; a job that cannot run is recorded as failed
 */
export async function processNextA11yJob(
  jobs: WorkerJobs,
  { heartbeatMs = 30_000 }: { heartbeatMs?: number } = {},
): Promise<ClaimedJob | null> {
  const job = await jobs.claim('a11y');
  if (!job) return null;
  let reported = false;
  const lost = (what: string) => {
    if (reported) return;
    reported = true;
    console.error(`[iris] worker: claim on job ${job.id} was lost; not recording its ${what}`);
  };
  // Once the outcome is being written, a heartbeat answer means nothing: one in flight
  // waits on finish's row lock and then sees a finished row.
  let writing = false;
  const timer = setInterval(() => {
    jobs.heartbeat(job).then(
      (held) => {
        if (held || writing) return;
        // Reaped: say so once and stop asking. The scan runs on; its write will be refused.
        clearInterval(timer);
        lost('outcome');
      },
      (err) => console.error(`[iris] worker job heartbeat ${job.id}:`, (err as Error).message),
    );
  }, heartbeatMs);
  try {
    let result;
    try {
      result = await runA11y(job.params);
    } catch (err) {
      writing = true;
      if (!(await jobs.fail(job, (err as Error).message || 'Job failed'))) lost('failure');
      return job;
    }
    writing = true;
    try {
      if (!(await jobs.finish(job, result))) lost('result');
    } catch (err) {
      // The outcome did not commit (nothing of it did): the job must not stay `running`.
      // The detail (a database error) is for the operator's log, not the tenant's job.
      console.error(`[iris] worker could not store job ${job.id}:`, (err as Error).message);
      if (!(await jobs.fail(job, 'Could not store the result'))) lost('failure');
    }
    return job;
  } finally {
    clearInterval(timer);
  }
}

/**
 * Polls until `signal` aborts; an abort lets the current job finish. A failure of the
 * database is logged and retried on the next tick: one bad moment must not end the worker.
 * ponytail: polling, not LISTEN/NOTIFY; add it when the poll interval shows up as latency.
 *
 * Liveness (#273): with `heartbeatFile`, the loop writes it at every tick, and a timer
 * every `heartbeatMs` while a job runs, so a long scan still reads as alive. The gap
 * between writes is at most max(pollMs, heartbeatMs) plus one claim; the compose
 * healthcheck allows 180s.
 */
export async function runWorker(options: {
  jobs: WorkerJobs;
  signal?: AbortSignal;
  pollMs?: number;
  heartbeatFile?: string;
  heartbeatMs?: number;
  /** A running job with no heartbeat for this long is taken back (#435). */
  staleMs?: number;
  /** Claims a job gets before a reap fails it instead of requeueing it. */
  maxAttempts?: number;
}): Promise<void> {
  const {
    jobs,
    signal,
    pollMs = 2_000,
    heartbeatFile,
    heartbeatMs = 30_000,
    staleMs = DEFAULT_STALE_MS,
    maxAttempts,
  } = options;
  // A live job beats every heartbeatMs; the reaper must not mistake one late beat for death.
  if (heartbeatMs * 2 >= staleMs) {
    throw new Error(`heartbeatMs (${heartbeatMs}) must be under half of staleMs (${staleMs})`);
  }
  const beat = () => {
    if (!heartbeatFile) return;
    try {
      fs.writeFileSync(heartbeatFile, `${Date.now()}\n`);
    } catch (err) {
      console.error('[iris] worker heartbeat:', (err as Error).message);
    }
  };
  while (!signal?.aborted) {
    beat();
    const timer = heartbeatFile ? setInterval(beat, heartbeatMs) : undefined;
    let ran = false;
    try {
      // One indexed statement per tick; a reaper failure must not stop claims.
      try {
        const { requeued, failed } = await jobs.reapStuck({ staleMs, maxAttempts });
        if (requeued || failed) {
          console.error(`[iris] worker reaped stuck jobs: ${requeued} requeued, ${failed} failed`);
        }
      } catch (err) {
        console.error('[iris] worker reaper error:', (err as Error).message);
      }
      ran = (await processNextA11yJob(jobs, { heartbeatMs })) !== null;
    } catch (err) {
      console.error('[iris] worker error:', (err as Error).message);
    } finally {
      clearInterval(timer);
    }
    if (!ran && !signal?.aborted) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, pollMs);
        signal?.addEventListener('abort', done, { once: true });
      });
    }
  }
}
