/**
 * Run-history persistence for the visual and a11y commands.
 *
 * `db.ts` has always held insert/get helpers plus indexed tables for both
 * result kinds — and nothing in `src` ever called them, so every run vanished
 * the moment the process exited (issue #77).
 *
 * This lives at the command layer rather than inside the runners on purpose:
 * the runners are also driven by the MCP server and by library consumers, and a
 * scan performed on someone else's behalf should not silently write to the
 * user's history. `watcher.ts` persists at the same layer for the same reason.
 */

import * as path from 'path';
import * as os from 'os';
import {
  initializeDatabase,
  insertA11yTestResult,
  insertTestRun,
  insertVisualTestResult,
} from './db';
import { calculateAccessibilityScore } from './a11y/a11y-runner';
import type { AccessibilityTestResult } from './a11y/a11y-runner';
import type { VisualTestResult as VisualRunResult } from './visual/visual-runner';

/** Same location and override the watcher uses, so all history lands in one file. */
function resolveDbPath(): string {
  return process.env.IRIS_DB_PATH || path.join(os.homedir(), '.iris', 'iris.db');
}

/**
 * Open the history database, hand it to `write`, and always close it.
 *
 * Every failure is reported and swallowed. History is a side effect of a test
 * run, so a read-only disk or a corrupt file must never turn a green run red —
 * the same contract `watcher.ts` applies to its own persistence.
 */
function withHistoryDb(label: string, write: (db: ReturnType<typeof initializeDatabase>) => void) {
  try {
    const db = initializeDatabase(resolveDbPath());
    try {
      write(db);
    } finally {
      db.close();
    }
  } catch (error) {
    console.error(`⚠️  Failed to persist ${label} run to database:`, error);
  }
}

/**
 * Runner severities are minor/moderate/breaking; the table stores the
 * low/medium/high/critical scale. `high` is unreachable from this direction —
 * the runner has no severity between moderate and breaking.
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

/** Record a completed `iris visual` run: one test_run plus a row per comparison. */
export function recordVisualRun(result: VisualRunResult, startTime: Date, endTime: Date): void {
  withHistoryDb('visual', (db) => {
    const testRunId = insertTestRun(db, {
      instruction: `visual: ${result.summary.totalComparisons} comparison(s), ${result.summary.failed} failed`,
      status: result.summary.overallStatus === 'failed' ? 'error' : 'success',
      startTime,
      endTime,
    });

    for (const comparison of result.results) {
      insertVisualTestResult(db, {
        testRunId,
        page: comparison.page,
        device: comparison.device,
        baselineRef: comparison.baselinePath ?? null,
        currentRef: comparison.screenshotPath,
        diffRef: comparison.diffPath ?? null,
        // A fraction, matching the column's name. `pixelDifference` is a raw
        // count of pixels, which would read as a nonsense percentage.
        diffPercentage: 1 - comparison.similarity,
        aiAnalysis: comparison.aiAnalysis ? JSON.stringify(comparison.aiAnalysis) : null,
        severity: toStoredSeverity(comparison.severity),
        status: comparison.passed ? 'passed' : 'failed',
        timestamp: endTime,
      });
    }
  });
}

/** Record a completed `iris a11y` run: one test_run plus a row per page. */
export function recordA11yRun(
  result: AccessibilityTestResult,
  startTime: Date,
  endTime: Date,
): void {
  withHistoryDb('accessibility', (db) => {
    const testRunId = insertTestRun(db, {
      instruction: `a11y: ${result.summary.pagesTested} page(s), ${result.summary.totalViolations} violation(s)`,
      status: result.summary.passed ? 'success' : 'error',
      startTime,
      endTime,
    });

    for (const page of result.results) {
      const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
      for (const violation of page.axeResult.violations) {
        if (violation.impact && violation.impact in counts) {
          counts[violation.impact as keyof typeof counts] += 1;
        }
      }

      insertA11yTestResult(db, {
        testRunId,
        page: page.page,
        violationsCritical: counts.critical,
        violationsSerious: counts.serious,
        violationsModerate: counts.moderate,
        violationsMinor: counts.minor,
        // Absent sub-tests mean "not run", which is not a failure to record.
        keyboardPassed: page.keyboardResult?.passed ?? true,
        screenReaderPassed: page.screenReaderResult?.passed ?? true,
        // Scored per page against its own violations — writing the run-wide
        // score into every row would misreport each individual page.
        score: calculateAccessibilityScore(counts, 1),
        status: page.axeResult.violations.length > 0 ? 'failed' : 'passed',
        timestamp: endTime,
      });
    }
  });
}
