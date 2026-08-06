/**
 * Tests for run-history persistence (issue #77).
 *
 * The visual/a11y persistence helpers and their two tables were written, tested
 * and indexed — and never called from `src`. Every `iris visual` / `iris a11y`
 * run vanished. These tests pin the wiring, and specifically pin that a broken
 * database can never fail a test run: history is a side effect, not the product.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { recordA11yRun, recordVisualRun } from '../src/history';
import { getA11yTestResults, getVisualTestResults, getTestRuns, initializeDatabase } from '../src/db';
import type { VisualTestResult as VisualRunResult } from '../src/visual/visual-runner';
import type { AccessibilityTestResult } from '../src/a11y/a11y-runner';

const tempDir = path.join(os.tmpdir(), 'iris-history-test');
const dbPath = path.join(tempDir, 'history.db');

/** A two-page visual run: one clean pass, one breaking failure with AI analysis. */
const visualRun: VisualRunResult = {
  summary: {
    totalComparisons: 2,
    passed: 1,
    failed: 1,
    newBaselines: 0,
    overallStatus: 'failed',
    severityCounts: { breaking: 1 },
  },
  results: [
    {
      page: '/home',
      device: 'desktop',
      passed: true,
      similarity: 1.0,
      pixelDifference: 0,
      threshold: 0.1,
      screenshotPath: '/tmp/home.png',
      baselinePath: '/tmp/baseline-home.png',
    },
    {
      page: '/about',
      device: 'mobile',
      passed: false,
      similarity: 0.85,
      pixelDifference: 3000,
      threshold: 0.1,
      ssim: 0.78,
      severity: 'breaking',
      screenshotPath: '/tmp/about.png',
      baselinePath: '/tmp/baseline-about.png',
      diffPath: '/tmp/diff-about.png',
      aiAnalysis: {
        classification: 'unintentional',
        confidence: 0.95,
        description: 'Nav shifted',
        severity: 'high',
        suggestions: ['check flex-basis'],
        isIntentional: false,
        changeType: 'layout',
        reasoning: 'nav dropped 12px',
      },
    },
  ],
  duration: 5000,
};

/** A one-page a11y run with a mix of impacts. */
const a11yRun: AccessibilityTestResult = {
  summary: {
    totalViolations: 3,
    score: 60,
    passed: false,
    violationsBySeverity: { critical: 1, serious: 1, moderate: 1, minor: 0 },
    pagesTested: 1,
    keyboardTestsPassed: 0,
    keyboardTestsFailed: 1,
  },
  results: [
    {
      page: '/home',
      axeResult: {
        testName: 'home',
        url: 'http://localhost:3000/home',
        timestamp: new Date(),
        passed: false,
        violations: [
          { id: 'a', impact: 'critical' },
          { id: 'b', impact: 'serious' },
          { id: 'c', impact: 'moderate' },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ] as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        passes: [] as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      keyboardResult: { testName: 'home', passed: false } as any,
    },
  ],
  duration: 3000,
};

describe('run history persistence (issue #77)', () => {
  beforeEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.mkdirSync(tempDir, { recursive: true });
    process.env.IRIS_DB_PATH = dbPath;
  });

  afterEach(() => {
    delete process.env.IRIS_DB_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('recordVisualRun', () => {
    it('writes one test run and a row per comparison', () => {
      recordVisualRun(visualRun, new Date(), new Date());

      const db = initializeDatabase(dbPath);
      try {
        expect(getTestRuns(db)).toHaveLength(1);

        const rows = getVisualTestResults(db);
        expect(rows).toHaveLength(2);
        expect(rows.map((r) => r.page).sort()).toEqual(['/about', '/home']);
      } finally {
        db.close();
      }
    });

    it('maps the run verdict, severity and artefact paths onto the row', () => {
      recordVisualRun(visualRun, new Date(), new Date());

      const db = initializeDatabase(dbPath);
      try {
        const failed = getVisualTestResults(db).find((r) => r.page === '/about')!;

        expect(failed.status).toBe('failed');
        // Runner severities are minor/moderate/breaking; the table stores
        // low/medium/high/critical, so breaking must land as critical.
        expect(failed.severity).toBe('critical');
        expect(failed.diffRef).toBe('/tmp/diff-about.png');
        expect(failed.baselineRef).toBe('/tmp/baseline-about.png');
        expect(failed.currentRef).toBe('/tmp/about.png');
        // diff_percentage is a fraction, derived from similarity — not the raw
        // pixel count, which is what `pixelDifference` holds.
        expect(failed.diffPercentage).toBeCloseTo(0.15, 5);
        expect(JSON.parse(failed.aiAnalysis!).changeType).toBe('layout');
      } finally {
        db.close();
      }
    });

    it('stores a passing comparison with no diff, severity or analysis', () => {
      recordVisualRun(visualRun, new Date(), new Date());

      const db = initializeDatabase(dbPath);
      try {
        const passing = getVisualTestResults(db).find((r) => r.page === '/home')!;

        expect(passing.status).toBe('passed');
        expect(passing.severity).toBeNull();
        expect(passing.diffRef).toBeNull();
        expect(passing.aiAnalysis).toBeNull();
      } finally {
        db.close();
      }
    });
  });

  describe('recordA11yRun', () => {
    it('writes one test run and a row per page with impact counts', () => {
      recordA11yRun(a11yRun, new Date(), new Date());

      const db = initializeDatabase(dbPath);
      try {
        expect(getTestRuns(db)).toHaveLength(1);

        const rows = getA11yTestResults(db);
        expect(rows).toHaveLength(1);
        expect(rows[0].page).toBe('/home');
        expect(rows[0].violationsCritical).toBe(1);
        expect(rows[0].violationsSerious).toBe(1);
        expect(rows[0].violationsModerate).toBe(1);
        expect(rows[0].violationsMinor).toBe(0);
        expect(rows[0].status).toBe('failed');
      } finally {
        db.close();
      }
    });

    it('scores each page on its own violations, not the run-wide score', () => {
      recordA11yRun(a11yRun, new Date(), new Date());

      const db = initializeDatabase(dbPath);
      try {
        // 1 critical (25) + 1 serious (10) + 1 moderate (5) = 40 penalty on a
        // single page => 60. Same weights the runner uses for its summary.
        expect(getA11yTestResults(db)[0].score).toBe(60);
      } finally {
        db.close();
      }
    });

    it('records keyboard and screen-reader outcomes, defaulting to passed when not run', () => {
      recordA11yRun(a11yRun, new Date(), new Date());

      const db = initializeDatabase(dbPath);
      try {
        const row = getA11yTestResults(db)[0];
        expect(row.keyboardPassed).toBe(false); // keyboardResult.passed === false
        expect(row.screenReaderPassed).toBe(true); // not run — not a failure
      } finally {
        db.close();
      }
    });
  });

  describe('failure isolation', () => {
    // History is a side effect. A read-only disk or a corrupt database must
    // never turn a green test run red.
    it('swallows database errors instead of throwing', () => {
      process.env.IRIS_DB_PATH = path.join(tempDir, 'nope.db');
      fs.writeFileSync(path.join(tempDir, 'nope.db'), 'this is not a sqlite file');
      const warn = jest.spyOn(console, 'error').mockImplementation();

      expect(() => recordVisualRun(visualRun, new Date(), new Date())).not.toThrow();
      expect(() => recordA11yRun(a11yRun, new Date(), new Date())).not.toThrow();
      expect(warn).toHaveBeenCalled();

      warn.mockRestore();
    });
  });
});
