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

import { resolveDbPath } from './data-dir';
import { initializeDatabase } from './db';
import { recordSqliteRun, type RunInput } from './history-store';
import type { AccessibilityTestResult } from './a11y/a11y-runner';
import type { VisualTestResult as VisualRunResult } from './visual/visual-runner';

/**
 * Write one run to the local history, and always close it.
 *
 * Every failure is reported and swallowed. History is a side effect of a test
 * run, so a read-only disk or a corrupt file must never turn a green run red —
 * the same contract `watcher.ts` applies to its own persistence.
 */
function persist(label: string, run: RunInput): void {
  try {
    const db = initializeDatabase(resolveDbPath());
    try {
      recordSqliteRun(db, run);
    } finally {
      db.close();
    }
  } catch (error) {
    console.error(`⚠️  Failed to persist ${label} run to database:`, error);
  }
}

/** Record a completed `iris visual` run: one test_run plus a row per comparison. */
export function recordVisualRun(result: VisualRunResult, startTime: Date, endTime: Date): void {
  persist('visual', { kind: 'visual', result, startedAt: startTime, finishedAt: endTime });
}

/** Record a completed `iris a11y` run: one test_run plus a row per page. */
export function recordA11yRun(
  result: AccessibilityTestResult,
  startTime: Date,
  endTime: Date,
): void {
  persist('accessibility', { kind: 'a11y', result, startedAt: startTime, finishedAt: endTime });
}
