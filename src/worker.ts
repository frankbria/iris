import * as fs from 'fs';
import type { ArtifactStore } from './artifact-store';
import type { A11yJobParams, ClaimedJob, JobKind, PostgresJobs } from './history-store';
import { errMessage, log } from './log';
import { metrics } from './metrics';

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

/** The error a suspended org's claimed job is failed with (#348). */
export const ORG_SUSPENDED = 'Organization suspended';

export type WorkerJobs = Pick<
  PostgresJobs,
  'claim' | 'finish' | 'fail' | 'heartbeat' | 'reapStuck'
> &
  Partial<Pick<PostgresJobs, 'queueDepth' | 'baselines'>>;

// Worker metrics (#275), served by `iris worker --metrics-port`. Outcome: `finished` (a
// verdict was stored, pass or fail), `error` (the job could not run or be stored, and is
// failed) or `lost` (reaped meanwhile; nothing written).
const jobsTotal = metrics.counter('iris_jobs_total', 'Jobs run, by kind and outcome');
const jobSeconds = metrics.histogram(
  'iris_job_duration_seconds',
  'Time from claim to stored outcome, by kind',
  [1, 5, 10, 30, 60, 120, 300, 600, 1800],
);
const jobsReaped = metrics.counter(
  'iris_jobs_reaped_total',
  'Stuck jobs taken back by the reaper, by result (requeued, failed)',
);

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
 * Claims and runs one a11y job; see `processNextJob`.
 */
export function processNextA11yJob(
  jobs: WorkerJobs,
  options: { heartbeatMs?: number } = {},
): Promise<ClaimedJob | null> {
  return processNextJob(jobs, 'a11y', (job) => runA11y(job.params as A11yJobParams), options);
}

/**
 * Claims and runs one visual-diff job (#268). Its images go to `artifacts` (scoped to the
 * job's org here); its baselines are the job's org's.
 */
export function processNextVisualJob(
  jobs: WorkerJobs,
  { artifacts, heartbeatMs }: { artifacts: ArtifactStore; heartbeatMs?: number },
): Promise<ClaimedJob | null> {
  if (!jobs.baselines) throw new Error("Visual jobs need the job store's baselines");
  const baselines = jobs.baselines;
  return processNextJob(
    jobs,
    'visual',
    async (job) => {
      if (job.kind !== 'visual') throw new Error(`Not a visual job: ${job.kind}`);
      const [{ runVisualJob }, { orgArtifacts }] = await Promise.all([
        import('./visual/hosted-job'),
        import('./artifact-store'),
      ]);
      return runVisualJob(job.params, {
        artifacts: orgArtifacts(artifacts, job.orgId),
        baselines: baselines(job.orgId),
        orgId: job.orgId,
        runId: job.id,
      });
    },
    { heartbeatMs },
  );
}

/**
 * Claims and runs one job of a kind. While it runs, a timer (every `heartbeatMs`) tells the
 * database the claim is alive; a job whose heartbeat stops is reaped (#435). A failed
 * heartbeat write is logged and never stops the job.
 * @returns the job, or `null` when the queue was empty
 * @throws only when the database cannot be written; a job that cannot run is recorded as failed
 */
async function processNextJob(
  jobs: WorkerJobs,
  kind: JobKind,
  run: (job: ClaimedJob) => Promise<Parameters<WorkerJobs['finish']>[1]>,
  { heartbeatMs = 30_000 }: { heartbeatMs?: number } = {},
): Promise<ClaimedJob | null> {
  const job = await jobs.claim(kind);
  if (!job) return null;
  const t0 = performance.now();
  const fields = { jobId: job.id, orgId: job.orgId, kind: job.kind, attempts: job.attempts };
  log('info', 'job claimed', fields);

  let reported = false;
  const lost = (what: string) => {
    if (reported) return;
    reported = true;
    log('warn', `claim on job ${job.id} was lost; not recording its ${what}`, fields);
  };
  /** One line and one sample per job, once its outcome is written (or refused). */
  let recorded = false;
  // `refused`: the job was not run (a suspended org, #348). Not `error`, which is the
  // watchdog's server-fault signal (#275): suspending an org must not page anyone.
  const done = (outcome: 'finished' | 'error' | 'refused', written: boolean, err?: string) => {
    recorded = true;
    const result = written ? outcome : 'lost';
    if (!written) lost(outcome === 'finished' ? 'result' : 'failure');
    const seconds = (performance.now() - t0) / 1000;
    jobsTotal.inc({ kind: job.kind, outcome: result });
    jobSeconds.observe({ kind: job.kind }, seconds);
    log(result === 'finished' || result === 'refused' ? 'info' : 'warn', `job ${result}`, {
      ...fields,
      latencyMs: Math.round(seconds * 1000),
      ...(err !== undefined && { err }),
    });
  };
  // A suspended org's job is not run (#348): failed with no usage, no browser started.
  // The message is the job's tenant-visible error, so it gives no operator reason.
  if (job.orgSuspended) {
    done('refused', await jobs.fail(job, ORG_SUSPENDED), ORG_SUSPENDED);
    return job;
  }
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
      (err) => log('error', `job heartbeat failed ${job.id}`, { ...fields, err: errMessage(err) }),
    );
  }, heartbeatMs);
  try {
    let result;
    try {
      result = await run(job);
    } catch (err) {
      writing = true;
      const message = (err as Error).message || 'Job failed';
      done('error', await jobs.fail(job, message), message);
      return job;
    }
    writing = true;
    let stored: boolean;
    try {
      stored = await jobs.finish(job, result);
    } catch (err) {
      // The outcome did not commit (nothing of it did): the job must not stay `running`.
      // The detail (a database error) is for the operator's log, not the tenant's job.
      log('error', `worker could not store job ${job.id}`, { ...fields, err: errMessage(err) });
      done(
        'error',
        await jobs.fail(job, 'Could not store the result'),
        'Could not store the result',
      );
      return job;
    }
    done('finished', stored);
    return job;
  } catch (err) {
    // Recording the outcome itself failed (the database is gone): still a job that ran
    // and errored, for the log and the metrics, before the caller hears of it.
    if (!recorded) {
      log('error', `could not record the outcome of job ${job.id}`, {
        ...fields,
        err: errMessage(err),
      });
      done('error', true, errMessage(err));
    }
    throw err;
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
  /** Where visual jobs' images go (#268); without it visual jobs are not claimed. */
  artifacts?: ArtifactStore;
}): Promise<void> {
  const {
    jobs,
    signal,
    pollMs = 2_000,
    heartbeatFile,
    heartbeatMs = 30_000,
    staleMs = DEFAULT_STALE_MS,
    maxAttempts,
    artifacts,
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
      log('error', 'worker heartbeat file write failed', { err: errMessage(err) });
    }
  };
  // Sampled once per tick, so a scrape costs no query (#275).
  let depth = 0;
  metrics.gauge('iris_job_queue_depth', 'Queued jobs, sampled each worker tick', () => depth);
  while (!signal?.aborted) {
    beat();
    const timer = heartbeatFile ? setInterval(beat, heartbeatMs) : undefined;
    let ran = false;
    try {
      // One indexed statement per tick; a reaper failure must not stop claims.
      try {
        const { requeued, failed } = await jobs.reapStuck({ staleMs, maxAttempts });
        if (requeued || failed) {
          jobsReaped.inc({ result: 'requeued' }, requeued);
          jobsReaped.inc({ result: 'failed' }, failed);
          log('warn', `worker reaped stuck jobs: ${requeued} requeued, ${failed} failed`, {
            requeued,
            failed,
          });
        }
      } catch (err) {
        log('error', 'worker reaper error', { err: errMessage(err) });
      }
      if (jobs.queueDepth) {
        try {
          depth =
            (await jobs.queueDepth('a11y')) + (artifacts ? await jobs.queueDepth('visual') : 0);
        } catch (err) {
          log('error', 'worker queue depth query failed', { err: errMessage(err) });
        }
      }
      // One job per tick, a11y first; visual jobs only when there is somewhere to put
      // their images (the API refuses them without a store, #268).
      ran = (await processNextA11yJob(jobs, { heartbeatMs })) !== null;
      if (!ran && artifacts)
        ran = (await processNextVisualJob(jobs, { artifacts, heartbeatMs })) !== null;
    } catch (err) {
      log('error', 'worker error', { err: errMessage(err) });
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
