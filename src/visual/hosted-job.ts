import sharp from 'sharp';
import { launchBrowser, newHardenedContext } from '../browser';
import { baselineObjectKey, runArtifactKey, type ArtifactStore } from '../artifact-store';
import type { OrgBaselines, VisualDevice, VisualJobParams } from '../history-store';
import { guardedGoto, installUrlPolicyGuard } from '../url-policy-guard';
import { artifactName } from './artifacts';
import { VisualCaptureEngine } from './capture';
import { VisualDiffEngine } from './diff';
import type { VisualTestResult } from './visual-runner';

/**
 * One hosted visual-diff job (#268): every URL on every device, screenshotted and
 * compared with the project's baseline. Images go to object storage, never to the
 * worker's disk; the result carries their keys for run detail to sign (#460).
 *
 * A project's first screenshot of a page becomes its baseline. After that a baseline
 * changes only through approval (`approveVisualResult`), never by a run.
 */

const VIEWPORTS: Record<VisualDevice, { width: number; height: number }> = {
  desktop: { width: 1920, height: 1080 },
  laptop: { width: 1366, height: 768 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 375, height: 667 },
};

/** A job starts no new page after this; the reaper does not catch a slow live job (#442). */
export const JOB_DEADLINE_MS = 10 * 60_000;
const PAGE_TIMEOUT_MS = 30_000;
const FONTS_TIMEOUT_MS = 5_000;
/** Taller full-page screenshots are refused before they are decoded for a diff. */
export const MAX_PAGE_HEIGHT = 16_384;

/** The same thresholds as the local runner (#280), compared as similarity. */
function severityOf(similarity: number): 'minor' | 'moderate' | 'breaking' {
  if (similarity < 0.85) return 'breaking';
  if (similarity < 0.95) return 'moderate';
  return 'minor';
}

export async function runVisualJob(
  params: VisualJobParams,
  ctx: {
    /** Org-scoped (`orgArtifacts`): every key it writes is under the job's org. */
    artifacts: ArtifactStore;
    baselines: OrgBaselines;
    orgId: string;
    /** The run's uuid, which is also the run id in its artifact keys (#460). */
    runId: string;
    /** No new page is started after this long (default `JOB_DEADLINE_MS`). */
    deadlineMs?: number;
    /** Taller screenshots are refused (default `MAX_PAGE_HEIGHT`). */
    maxPageHeight?: number;
  },
): Promise<VisualTestResult> {
  const t0 = Date.now();
  const deadlineMs = ctx.deadlineMs ?? JOB_DEADLINE_MS;
  const deadline = t0 + deadlineMs;
  const capture = new VisualCaptureEngine();
  const diff = new VisualDiffEngine();
  const results: VisualTestResult['results'] = [];
  const browser = await launchBrowser();
  try {
    for (const device of params.devices) {
      for (const url of params.urls) {
        const context = await newHardenedContext(browser, { viewport: VIEWPORTS[device] });
        try {
          const page = await context.newPage();
          // Before the first request, like the local runner (#335); hosted mode makes it
          // strict, and the egress proxy vets resolved addresses (#336).
          await installUrlPolicyGuard(page, {});
          let status = 0;
          page.on('response', (r) => {
            if (r.request().isNavigationRequest() && r.frame() === page.mainFrame())
              status = r.status();
          });
          if (Date.now() > deadline)
            throw new Error(`The job ran out of time (${Math.round(deadlineMs / 1000)} s)`);
          await guardedGoto(page, url, { waitUntil: 'networkidle', timeout: PAGE_TIMEOUT_MS });
          // The egress proxy answers a refused target with a 403 page: that must fail the
          // job, not become a project's baseline (#267's hand-off).
          if (status >= 400) throw new Error(`${url} answered HTTP ${status}`);
          // Bounded: a page can keep a font pending forever, and the heartbeat would keep
          // the job alive while it waited (#442).
          await Promise.race([
            page.evaluate('document.fonts.ready.then(() => undefined)'),
            new Promise((r) => setTimeout(r, FONTS_TIMEOUT_MS)),
          ]);
          const shot = await capture.capture(page, {
            fullPage: true,
            maskSelectors: [],
            stabilizeMs: 0,
            disableAnimations: true,
            type: 'png',
          });
          if (!shot.success || !shot.buffer)
            throw new Error(`Could not capture ${url}: ${shot.error}`);
          // A full page can be very tall; decoding two of those for the diff is width x
          // height x 4 bytes each, plus the diff's own buffers (#282).
          const { height = 0 } = await sharp(shot.buffer).metadata();
          const maxHeight = ctx.maxPageHeight ?? MAX_PAGE_HEIGHT;
          if (height > maxHeight)
            throw new Error(`${url} is ${height} px tall (${device}); the limit is ${maxHeight}`);

          const name = artifactName(url, device);
          const keyOf = (kind: 'current' | 'diff') =>
            runArtifactKey({
              orgId: ctx.orgId,
              projectId: params.project,
              runId: ctx.runId,
              kind,
              name,
            });
          const current = keyOf('current');
          await ctx.artifacts.put(current, shot.buffer, 'image/png');

          let baseline = await ctx.baselines.get(params.project, name);
          if (!baseline) {
            // Seeded insert-only: a concurrent job of the project, or a reaped one still
            // running, cannot overwrite a baseline (or an approval made meanwhile). The
            // image goes to a key of its own first, so a winning row never points at a
            // missing or replaced object.
            const objectKey = baselineObjectKey(ctx.orgId, params.project, name, ctx.runId);
            await ctx.artifacts.put(objectKey, shot.buffer, 'image/png');
            const seeded = await ctx.baselines.insertIfAbsent({
              project: params.project,
              name,
              page: url,
              device,
              objectKey,
              runId: ctx.runId,
              approvedBy: 'first-run',
            });
            if (seeded) {
              results.push({
                page: url,
                device,
                passed: true,
                similarity: 1,
                pixelDifference: 0,
                threshold: params.threshold,
                screenshotPath: '',
                project: params.project,
                newBaseline: true,
                artifacts: { current, baseline: objectKey },
              });
              continue;
            }
            // Another job seeded it first: compare with that one.
            baseline = await ctx.baselines.get(params.project, name);
            if (!baseline) throw new Error(`The baseline of ${url} (${device}) vanished`);
          }

          const previous = await ctx.artifacts.get(baseline.objectKey);
          if (!previous)
            throw new Error(`The baseline of ${url} (${device}) is missing from storage`);
          const compared = await diff.compare(previous, shot.buffer, {
            threshold: params.threshold,
            includeAA: false,
            alpha: 0.1,
            diffMask: false,
            diffColor: [255, 0, 0],
          });
          let diffKey: string | undefined;
          if (compared.diffBuffer && compared.pixelDifference > 0) {
            diffKey = keyOf('diff');
            await ctx.artifacts.put(diffKey, compared.diffBuffer, 'image/png');
          }
          results.push({
            page: url,
            device,
            passed: compared.success && compared.passed,
            similarity: compared.similarity,
            pixelDifference: compared.pixelDifference,
            threshold: params.threshold,
            ...(compared.ssim !== undefined && { ssim: compared.ssim }),
            ...(!compared.passed && { severity: severityOf(compared.similarity) }),
            // A comparison that could not be made (a page whose height changed, #282)
            // says why, instead of a bare "breaking".
            ...(!compared.success && compared.error && { error: compared.error }),
            screenshotPath: '',
            project: params.project,
            artifacts: { current, ...(diffKey && { diff: diffKey }), baseline: baseline.objectKey },
          });
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.passed);
  const severityCounts: VisualTestResult['summary']['severityCounts'] = {};
  for (const r of failed)
    if (r.severity) severityCounts[r.severity] = (severityCounts[r.severity] ?? 0) + 1;
  return {
    runId: ctx.runId,
    summary: {
      totalComparisons: results.length,
      passed: results.length - failed.length,
      failed: failed.length,
      newBaselines: results.filter((r) => r.newBaseline).length,
      overallStatus: failed.length ? 'failed' : 'passed',
      severityCounts,
    },
    results,
    duration: Date.now() - t0,
  };
}
