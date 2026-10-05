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
import {
  getA11yTestResults,
  getVisualTestResults,
  getTestRuns,
  initializeDatabase,
  insertTestRun,
} from '../src/db';
import { sqliteHistoryStore } from '../src/history-store';
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
        ] as any,

        passes: [] as any,
      } as any,

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

    // #284: a comparison that could not be made (navigation, capture) kept no reason here.
    it('keeps why a comparison could not be made, bounded and without URL userinfo', async () => {
      const broken = {
        page: '/checkout',
        device: 'desktop',
        passed: false,
        similarity: 0,
        pixelDifference: 1,
        threshold: 0.1,
        severity: 'breaking' as const,
        screenshotPath: '',
        error:
          'net::ERR_CONNECTION_REFUSED at https://ops:hunter2@shop.test/checkout ' +
          'x'.repeat(600),
      };
      recordVisualRun({ ...visualRun, results: [broken] }, new Date(), new Date());

      const db = initializeDatabase(dbPath);
      let stored: string | null | undefined;
      try {
        stored = getVisualTestResults(db)[0].error;
      } finally {
        db.close();
      }
      expect(stored).toMatch(/^net::ERR_CONNECTION_REFUSED at https:\/\/shop\.test\/checkout/);
      expect(stored).not.toContain('hunter2');
      expect([...stored!].length).toBeLessThanOrEqual(500);

      const store = sqliteHistoryStore(dbPath);
      const [run] = await store.list();
      expect((await store.get(run.id))!.results[0].result).toMatchObject({ error: stored });
    });

    it('adds the error column to a database made before it existed', () => {
      // A version-1 database: no `error` column, schema_version 1.
      const old = initializeDatabase(dbPath);
      old.exec(
        'ALTER TABLE visual_test_results DROP COLUMN error; DELETE FROM schema_version WHERE version > 1',
      );
      old.close();

      recordVisualRun(visualRun, new Date(), new Date());

      const db = initializeDatabase(dbPath);
      try {
        expect(getVisualTestResults(db)).toHaveLength(2);
        const cols = db.prepare('PRAGMA table_info(visual_test_results)').all() as {
          name: string;
        }[];
        expect(cols.map((c) => c.name)).toContain('error');
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

describe('sqliteHistoryStore: the local history behind the HistoryStore seam (#254)', () => {
  beforeEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('lists what the CLI recorded and reads each run back with its results', async () => {
    process.env.IRIS_DB_PATH = dbPath;
    try {
      recordVisualRun(
        visualRun,
        new Date('2026-10-01T10:00:00Z'),
        new Date('2026-10-01T10:00:05Z'),
      );
      recordA11yRun(a11yRun, new Date('2026-10-01T11:00:00Z'), new Date('2026-10-01T11:00:03Z'));
    } finally {
      delete process.env.IRIS_DB_PATH;
    }
    // A row `iris run` writes is not a run of this store.
    const db = initializeDatabase(dbPath);
    insertTestRun(db, {
      instruction: 'click the login button',
      status: 'success',
      startTime: new Date(),
    });
    // ...even one whose instruction happens to start like a run summary.
    insertTestRun(db, {
      instruction: 'visual: compare the homepage',
      status: 'success',
      startTime: new Date(),
    });
    // `created_at` has one-second resolution, so runs recorded together tie on it.
    // Force the tie: the order must come from insertion order, not from luck.
    db.prepare("UPDATE test_results SET created_at = '2026-10-01 00:00:00'").run();
    // A later comparison stamped a second later: an order taken from created_at
    // (newest first) would put it first.
    db.prepare(
      "UPDATE visual_test_results SET created_at = CASE page WHEN '/about' THEN '2026-10-01 00:00:01' ELSE '2026-10-01 00:00:00' END",
    ).run();
    db.close();

    const store = sqliteHistoryStore(dbPath);
    const runs = await store.list();
    expect(runs.map((r) => [r.kind, r.status, r.summary])).toEqual([
      ['a11y', 'failed', 'a11y: 1 page(s), 3 violation(s)'],
      ['visual', 'failed', 'visual: 2 comparison(s), 1 failed'],
    ]);
    const visual = await store.get(runs[1].id);
    // In the order they ran, like the Postgres store.
    expect(visual!.results.map((r) => [r.url, r.passed])).toEqual([
      ['/home', true],
      ['/about', false],
    ]);
    const a11y = await store.get(runs[0].id);
    expect(a11y!.results).toEqual([
      {
        url: '/home',
        passed: false,
        result: expect.objectContaining({
          violations: { critical: 1, serious: 1, moderate: 1, minor: 0 },
          keyboardPassed: false,
        }),
      },
    ]);
    expect(await store.get('999')).toBeNull();
    expect(await store.list({ limit: 1 })).toHaveLength(1);
  });

  it('records through the store with the same rows the CLI writes', async () => {
    const store = sqliteHistoryStore(dbPath);
    const id = await store.record({
      kind: 'visual',
      result: visualRun,
      startedAt: new Date(),
      finishedAt: new Date(),
    });
    const db = initializeDatabase(dbPath);
    try {
      expect(getVisualTestResults(db, { testRunId: Number(id) })).toHaveLength(2);
    } finally {
      db.close();
    }
  });
});
