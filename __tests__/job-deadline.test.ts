/**
 * The job deadline's arithmetic (#442). The worker keeps its own copies of the runners'
 * budgets so it never loads them to read one; these tests keep the copies honest. The
 * behaviour itself (a held page, a closed browser, a freed worker) is in
 * hosted-a11y-job.test.ts, against real Postgres and Chromium.
 */

import { A11Y_PAGE_TIMEOUT_MS } from '../src/a11y/a11y-runner';
import { JOB_DEADLINE_MS } from '../src/visual/hosted-job';
import {
  A11Y_PAGE_BUDGET_MS,
  jobDeadlineMs,
  MAX_JOB_MS,
  VISUAL_JOB_BUDGET_MS,
} from '../src/worker';

const a11y = (pages: number) =>
  ({
    kind: 'a11y',
    params: { urls: Array.from({ length: pages }, (_, i) => `https://x.test/${i}`) },
  }) as Parameters<typeof jobDeadlineMs>[0];

it("uses the runners' own budgets", () => {
  expect(A11Y_PAGE_BUDGET_MS).toBe(A11Y_PAGE_TIMEOUT_MS);
  expect(VISUAL_JOB_BUDGET_MS).toBe(JOB_DEADLINE_MS);
});

it('gives an a11y job its pages times the per-page budget, plus a margin, capped', () => {
  expect(jobDeadlineMs(a11y(1))).toBe(A11Y_PAGE_BUDGET_MS + 60_000);
  expect(jobDeadlineMs(a11y(3))).toBe(3 * A11Y_PAGE_BUDGET_MS + 60_000);
  expect(jobDeadlineMs(a11y(20))).toBe(MAX_JOB_MS);
});

it('gives a visual job its own cutoff plus room for the pages under way', () => {
  const visual = { kind: 'visual', params: {} } as Parameters<typeof jobDeadlineMs>[0];
  expect(jobDeadlineMs(visual)).toBe(VISUAL_JOB_BUDGET_MS + 5 * 60_000);
  expect(jobDeadlineMs(visual)).toBeLessThanOrEqual(MAX_JOB_MS);
});
