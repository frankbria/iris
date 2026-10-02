import type { A11yJobParams, ClaimedJob, PostgresJobs } from './history-store';

/**
 * The hosted job worker (#267, ADR 0001 §1): claims queued jobs from Postgres and
 * runs them. Same image as `iris connect`, another command. Runs under IRIS_HOSTED,
 * so the runner's browser goes through the egress proxy and its pages through the
 * hosted URL policy.
 */

export type WorkerJobs = Pick<PostgresJobs, 'claim' | 'finish' | 'fail'>;

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
    // No `output`: the result is stored, not written to the worker's disk.
  }).run();
}

/**
 * Claims and runs one job.
 * @returns the job, or `null` when the queue was empty
 * @throws only when the database cannot be written; a job that cannot run is recorded as failed
 */
export async function processNextA11yJob(jobs: WorkerJobs): Promise<ClaimedJob | null> {
  const job = await jobs.claim('a11y');
  if (!job) return null;
  let result;
  try {
    result = await runA11y(job.params);
  } catch (err) {
    await jobs.fail(job, (err as Error).message || 'Job failed');
    return job;
  }
  try {
    await jobs.finish(job, result);
  } catch (err) {
    // The outcome did not commit (nothing of it did): the job must not stay `running`.
    await jobs.fail(job, `Could not store the result: ${(err as Error).message}`);
  }
  return job;
}

/**
 * Polls until `signal` aborts; an abort lets the current job finish. A failure of the
 * database is logged and retried on the next tick: one bad moment must not end the worker.
 * ponytail: polling, not LISTEN/NOTIFY; add it when the poll interval shows up as latency.
 */
export async function runWorker(options: {
  jobs: WorkerJobs;
  signal?: AbortSignal;
  pollMs?: number;
}): Promise<void> {
  const { jobs, signal, pollMs = 2_000 } = options;
  while (!signal?.aborted) {
    let ran = false;
    try {
      ran = (await processNextA11yJob(jobs)) !== null;
    } catch (err) {
      console.error('[iris] worker error:', (err as Error).message);
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
