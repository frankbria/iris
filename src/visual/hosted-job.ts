import { launchBrowser, newHardenedContext } from '../browser';
import { baselineKey, runArtifactKey, type ArtifactStore } from '../artifact-store';
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
  },
): Promise<VisualTestResult> {
  const t0 = Date.now();
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
          await guardedGoto(page, url, { waitUntil: 'networkidle' });
          // The egress proxy answers a refused target with a 403 page: that must fail the
          // job, not become a project's baseline (#267's hand-off).
          if (status >= 400) throw new Error(`${url} answered HTTP ${status}`);
          await page.evaluate('document.fonts.ready.then(() => undefined)');
          const shot = await capture.capture(page, {
            fullPage: true,
            maskSelectors: [],
            stabilizeMs: 0,
            disableAnimations: true,
            type: 'png',
          });
          if (!shot.success || !shot.buffer)
            throw new Error(`Could not capture ${url}: ${shot.error}`);

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

          const baseline = await ctx.baselines.get(params.project, name);
          if (!baseline) {
            const objectKey = baselineKey({ orgId: ctx.orgId, projectId: params.project, name });
            await ctx.artifacts.put(objectKey, shot.buffer, 'image/png');
            await ctx.baselines.set({
              project: params.project,
              name,
              page: url,
              device,
              objectKey,
              runId: ctx.runId,
              approvedBy: 'first-run',
            });
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
