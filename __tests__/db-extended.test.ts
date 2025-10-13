import {
  initializeDatabase,
  insertTestRun,
  insertVisualTestResult,
  insertA11yTestResult,
  getVisualTestResults,
  getA11yTestResults,
  getVisualTestStats,
  getA11yTestStats,
  VisualTestResult,
  A11yTestResult
} from '../src/db';
import * as fs from 'fs';
import * as path from 'path';

describe('Database Extended Module - Visual and A11y Tests', () => {
  const testDbPath = path.join(__dirname, 'test-extended.db');
  let db: any;
  let testRunId: number;

  beforeEach(() => {
    // Clean up test database before each test
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }

    // Initialize database and create a test run
    db = initializeDatabase(testDbPath);
    testRunId = insertTestRun(db, {
      instruction: 'test visual and a11y',
      status: 'success',
      startTime: new Date(),
      endTime: new Date()
    });
  });

  afterEach(() => {
    // Close and clean up test database after each test
    if (db) {
      db.close();
    }
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  describe('Schema and Migration', () => {
    test('initializeDatabase creates all required tables', () => {
      // Verify visual_test_results table
      const visualTableInfo = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='visual_test_results'").get();
      expect(visualTableInfo).toBeDefined();

      // Verify a11y_test_results table
      const a11yTableInfo = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='a11y_test_results'").get();
      expect(a11yTableInfo).toBeDefined();

      // Verify schema_version table
      const schemaTableInfo = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'").get();
      expect(schemaTableInfo).toBeDefined();
    });

    test('schema version is tracked correctly', () => {
      const versionRow = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get();
      expect(versionRow).toBeDefined();
      expect(versionRow.version).toBe(1);
    });

    test('indexes are created for performance', () => {
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all();
      const indexNames = indexes.map((idx: any) => idx.name);

      expect(indexNames).toContain('idx_visual_test_run_id');
      expect(indexNames).toContain('idx_visual_page');
      expect(indexNames).toContain('idx_visual_status');
      expect(indexNames).toContain('idx_a11y_test_run_id');
      expect(indexNames).toContain('idx_a11y_page');
      expect(indexNames).toContain('idx_a11y_status');
    });

    test('foreign keys are enabled', () => {
      const fkStatus = db.pragma('foreign_keys', { simple: true });
      expect(fkStatus).toBe(1);
    });
  });

  describe('Visual Test Results', () => {
    test('insertVisualTestResult stores record correctly', () => {
      const visualResult: VisualTestResult = {
        testRunId,
        page: 'home',
        device: 'desktop',
        baselineRef: '/baselines/home-desktop.png',
        currentRef: '/current/home-desktop.png',
        diffRef: '/diffs/home-desktop.png',
        diffPercentage: 2.5,
        aiAnalysis: 'Minor layout shift detected in header',
        severity: 'low',
        status: 'passed',
        timestamp: new Date()
      };

      const id = insertVisualTestResult(db, visualResult);

      expect(typeof id).toBe('number');
      expect(id).toBeGreaterThan(0);
    });

    test('insertVisualTestResult handles null values', () => {
      const visualResult: VisualTestResult = {
        testRunId,
        page: 'login',
        device: 'mobile',
        baselineRef: null,
        currentRef: '/current/login-mobile.png',
        diffRef: null,
        diffPercentage: 0,
        aiAnalysis: null,
        severity: null,
        status: 'new_baseline',
        timestamp: new Date()
      };

      const id = insertVisualTestResult(db, visualResult);
      expect(id).toBeGreaterThan(0);

      const results = getVisualTestResults(db, { testRunId });
      expect(results[0].baselineRef).toBeNull();
      expect(results[0].aiAnalysis).toBeNull();
    });

    test('getVisualTestResults retrieves all results for test run', () => {
      // Insert multiple results
      for (let i = 0; i < 3; i++) {
        insertVisualTestResult(db, {
          testRunId,
          page: `page${i}`,
          device: 'desktop',
          baselineRef: `/baselines/page${i}.png`,
          currentRef: `/current/page${i}.png`,
          diffRef: `/diffs/page${i}.png`,
          diffPercentage: i * 1.5,
          aiAnalysis: `Analysis ${i}`,
          severity: 'low',
          status: 'passed',
          timestamp: new Date()
        });
      }

      const results = getVisualTestResults(db, { testRunId });
      expect(results).toHaveLength(3);
      expect(results.every(r => r.testRunId === testRunId)).toBe(true);
    });

    test('getVisualTestResults filters by page', () => {
      insertVisualTestResult(db, {
        testRunId,
        page: 'home',
        device: 'desktop',
        baselineRef: null,
        currentRef: '/current/home.png',
        diffRef: null,
        diffPercentage: 0,
        aiAnalysis: null,
        severity: null,
        status: 'passed',
        timestamp: new Date()
      });

      insertVisualTestResult(db, {
        testRunId,
        page: 'about',
        device: 'desktop',
        baselineRef: null,
        currentRef: '/current/about.png',
        diffRef: null,
        diffPercentage: 0,
        aiAnalysis: null,
        severity: null,
        status: 'passed',
        timestamp: new Date()
      });

      const results = getVisualTestResults(db, { page: 'home' });
      expect(results).toHaveLength(1);
      expect(results[0].page).toBe('home');
    });

    test('getVisualTestResults filters by status', () => {
      insertVisualTestResult(db, {
        testRunId,
        page: 'home',
        device: 'desktop',
        baselineRef: null,
        currentRef: '/current/home.png',
        diffRef: null,
        diffPercentage: 0,
        aiAnalysis: null,
        severity: null,
        status: 'passed',
        timestamp: new Date()
      });

      insertVisualTestResult(db, {
        testRunId,
        page: 'about',
        device: 'desktop',
        baselineRef: '/baseline/about.png',
        currentRef: '/current/about.png',
        diffRef: '/diff/about.png',
        diffPercentage: 15.5,
        aiAnalysis: 'Significant changes',
        severity: 'high',
        status: 'failed',
        timestamp: new Date()
      });

      const failedResults = getVisualTestResults(db, { status: 'failed' });
      expect(failedResults).toHaveLength(1);
      expect(failedResults[0].status).toBe('failed');
    });

    test('getVisualTestResults respects limit', () => {
      for (let i = 0; i < 5; i++) {
        insertVisualTestResult(db, {
          testRunId,
          page: `page${i}`,
          device: 'desktop',
          baselineRef: null,
          currentRef: `/current/page${i}.png`,
          diffRef: null,
          diffPercentage: 0,
          aiAnalysis: null,
          severity: null,
          status: 'passed',
          timestamp: new Date()
        });
      }

      const results = getVisualTestResults(db, { limit: 3 });
      expect(results).toHaveLength(3);
    });

    test('getVisualTestStats returns correct statistics', () => {
      insertVisualTestResult(db, {
        testRunId,
        page: 'home',
        device: 'desktop',
        baselineRef: null,
        currentRef: '/current/home.png',
        diffRef: null,
        diffPercentage: 0,
        aiAnalysis: null,
        severity: null,
        status: 'passed',
        timestamp: new Date()
      });

      insertVisualTestResult(db, {
        testRunId,
        page: 'about',
        device: 'desktop',
        baselineRef: '/baseline/about.png',
        currentRef: '/current/about.png',
        diffRef: '/diff/about.png',
        diffPercentage: 12.3,
        aiAnalysis: null,
        severity: 'medium',
        status: 'failed',
        timestamp: new Date()
      });

      insertVisualTestResult(db, {
        testRunId,
        page: 'contact',
        device: 'mobile',
        baselineRef: null,
        currentRef: '/current/contact.png',
        diffRef: null,
        diffPercentage: 0,
        aiAnalysis: null,
        severity: null,
        status: 'new_baseline',
        timestamp: new Date()
      });

      const stats = getVisualTestStats(db, testRunId);
      expect(stats.total).toBe(3);
      expect(stats.passed).toBe(1);
      expect(stats.failed).toBe(1);
      expect(stats.newBaselines).toBe(1);
    });
  });

  describe('Accessibility Test Results', () => {
    test('insertA11yTestResult stores record correctly', () => {
      const a11yResult: A11yTestResult = {
        testRunId,
        page: 'home',
        violationsCritical: 2,
        violationsSerious: 5,
        violationsModerate: 8,
        violationsMinor: 12,
        keyboardPassed: true,
        screenReaderPassed: true,
        score: 85.5,
        status: 'passed',
        timestamp: new Date()
      };

      const id = insertA11yTestResult(db, a11yResult);

      expect(typeof id).toBe('number');
      expect(id).toBeGreaterThan(0);
    });

    test('insertA11yTestResult handles boolean values correctly', () => {
      const a11yResult: A11yTestResult = {
        testRunId,
        page: 'login',
        violationsCritical: 1,
        violationsSerious: 0,
        violationsModerate: 0,
        violationsMinor: 0,
        keyboardPassed: false,
        screenReaderPassed: true,
        score: 75.0,
        status: 'warning',
        timestamp: new Date()
      };

      const id = insertA11yTestResult(db, a11yResult);
      const results = getA11yTestResults(db, { testRunId });

      expect(results[0].keyboardPassed).toBe(false);
      expect(results[0].screenReaderPassed).toBe(true);
    });

    test('getA11yTestResults retrieves all results for test run', () => {
      for (let i = 0; i < 3; i++) {
        insertA11yTestResult(db, {
          testRunId,
          page: `page${i}`,
          violationsCritical: i,
          violationsSerious: i * 2,
          violationsModerate: i * 3,
          violationsMinor: i * 4,
          keyboardPassed: true,
          screenReaderPassed: true,
          score: 90 - i * 5,
          status: 'passed',
          timestamp: new Date()
        });
      }

      const results = getA11yTestResults(db, { testRunId });
      expect(results).toHaveLength(3);
      expect(results.every(r => r.testRunId === testRunId)).toBe(true);
    });

    test('getA11yTestResults filters by page', () => {
      insertA11yTestResult(db, {
        testRunId,
        page: 'home',
        violationsCritical: 0,
        violationsSerious: 0,
        violationsModerate: 0,
        violationsMinor: 0,
        keyboardPassed: true,
        screenReaderPassed: true,
        score: 100,
        status: 'passed',
        timestamp: new Date()
      });

      insertA11yTestResult(db, {
        testRunId,
        page: 'about',
        violationsCritical: 1,
        violationsSerious: 2,
        violationsModerate: 3,
        violationsMinor: 4,
        keyboardPassed: false,
        screenReaderPassed: false,
        score: 60,
        status: 'failed',
        timestamp: new Date()
      });

      const results = getA11yTestResults(db, { page: 'home' });
      expect(results).toHaveLength(1);
      expect(results[0].page).toBe('home');
    });

    test('getA11yTestResults filters by status', () => {
      insertA11yTestResult(db, {
        testRunId,
        page: 'home',
        violationsCritical: 0,
        violationsSerious: 0,
        violationsModerate: 0,
        violationsMinor: 0,
        keyboardPassed: true,
        screenReaderPassed: true,
        score: 100,
        status: 'passed',
        timestamp: new Date()
      });

      insertA11yTestResult(db, {
        testRunId,
        page: 'about',
        violationsCritical: 5,
        violationsSerious: 10,
        violationsModerate: 15,
        violationsMinor: 20,
        keyboardPassed: false,
        screenReaderPassed: false,
        score: 40,
        status: 'failed',
        timestamp: new Date()
      });

      const failedResults = getA11yTestResults(db, { status: 'failed' });
      expect(failedResults).toHaveLength(1);
      expect(failedResults[0].status).toBe('failed');
    });

    test('getA11yTestResults respects limit', () => {
      for (let i = 0; i < 5; i++) {
        insertA11yTestResult(db, {
          testRunId,
          page: `page${i}`,
          violationsCritical: 0,
          violationsSerious: 0,
          violationsModerate: 0,
          violationsMinor: 0,
          keyboardPassed: true,
          screenReaderPassed: true,
          score: 100,
          status: 'passed',
          timestamp: new Date()
        });
      }

      const results = getA11yTestResults(db, { limit: 3 });
      expect(results).toHaveLength(3);
    });

    test('getA11yTestStats returns correct statistics', () => {
      insertA11yTestResult(db, {
        testRunId,
        page: 'home',
        violationsCritical: 1,
        violationsSerious: 2,
        violationsModerate: 3,
        violationsMinor: 4,
        keyboardPassed: true,
        screenReaderPassed: true,
        score: 85,
        status: 'passed',
        timestamp: new Date()
      });

      insertA11yTestResult(db, {
        testRunId,
        page: 'about',
        violationsCritical: 5,
        violationsSerious: 6,
        violationsModerate: 7,
        violationsMinor: 8,
        keyboardPassed: false,
        screenReaderPassed: false,
        score: 50,
        status: 'failed',
        timestamp: new Date()
      });

      insertA11yTestResult(db, {
        testRunId,
        page: 'contact',
        violationsCritical: 0,
        violationsSerious: 1,
        violationsModerate: 2,
        violationsMinor: 3,
        keyboardPassed: true,
        screenReaderPassed: false,
        score: 75,
        status: 'warning',
        timestamp: new Date()
      });

      const stats = getA11yTestStats(db, testRunId);
      expect(stats.total).toBe(3);
      expect(stats.passed).toBe(1);
      expect(stats.failed).toBe(1);
      expect(stats.warnings).toBe(1);
      expect(stats.totalViolations.critical).toBe(6);
      expect(stats.totalViolations.serious).toBe(9);
      expect(stats.totalViolations.moderate).toBe(12);
      expect(stats.totalViolations.minor).toBe(15);
    });
  });

  describe('Foreign Key Constraints', () => {
    test('visual test results are deleted when test run is deleted', () => {
      insertVisualTestResult(db, {
        testRunId,
        page: 'home',
        device: 'desktop',
        baselineRef: null,
        currentRef: '/current/home.png',
        diffRef: null,
        diffPercentage: 0,
        aiAnalysis: null,
        severity: null,
        status: 'passed',
        timestamp: new Date()
      });

      // Delete the test run
      db.prepare('DELETE FROM test_results WHERE id = ?').run(testRunId);

      // Verify visual results are also deleted
      const results = getVisualTestResults(db, { testRunId });
      expect(results).toHaveLength(0);
    });

    test('a11y test results are deleted when test run is deleted', () => {
      insertA11yTestResult(db, {
        testRunId,
        page: 'home',
        violationsCritical: 0,
        violationsSerious: 0,
        violationsModerate: 0,
        violationsMinor: 0,
        keyboardPassed: true,
        screenReaderPassed: true,
        score: 100,
        status: 'passed',
        timestamp: new Date()
      });

      // Delete the test run
      db.prepare('DELETE FROM test_results WHERE id = ?').run(testRunId);

      // Verify a11y results are also deleted
      const results = getA11yTestResults(db, { testRunId });
      expect(results).toHaveLength(0);
    });
  });

  describe('Combined Queries', () => {
    test('can retrieve both visual and a11y results for same test run', () => {
      // Insert visual result
      insertVisualTestResult(db, {
        testRunId,
        page: 'home',
        device: 'desktop',
        baselineRef: null,
        currentRef: '/current/home.png',
        diffRef: null,
        diffPercentage: 0,
        aiAnalysis: null,
        severity: null,
        status: 'passed',
        timestamp: new Date()
      });

      // Insert a11y result
      insertA11yTestResult(db, {
        testRunId,
        page: 'home',
        violationsCritical: 0,
        violationsSerious: 0,
        violationsModerate: 0,
        violationsMinor: 0,
        keyboardPassed: true,
        screenReaderPassed: true,
        score: 100,
        status: 'passed',
        timestamp: new Date()
      });

      const visualResults = getVisualTestResults(db, { testRunId });
      const a11yResults = getA11yTestResults(db, { testRunId });

      expect(visualResults).toHaveLength(1);
      expect(a11yResults).toHaveLength(1);
      expect(visualResults[0].page).toBe(a11yResults[0].page);
    });
  });

  describe('Query Options Coverage', () => {
    test('getVisualTestResults without options returns all results', () => {
      insertVisualTestResult(db, {
        testRunId,
        page: 'home',
        device: 'desktop',
        baselineRef: null,
        currentRef: '/current/home.png',
        diffRef: null,
        diffPercentage: 0,
        aiAnalysis: null,
        severity: null,
        status: 'passed',
        timestamp: new Date()
      });

      const results = getVisualTestResults(db);
      expect(results.length).toBeGreaterThan(0);
    });

    test('getA11yTestResults without options returns all results', () => {
      insertA11yTestResult(db, {
        testRunId,
        page: 'home',
        violationsCritical: 0,
        violationsSerious: 0,
        violationsModerate: 0,
        violationsMinor: 0,
        keyboardPassed: true,
        screenReaderPassed: true,
        score: 100,
        status: 'passed',
        timestamp: new Date()
      });

      const results = getA11yTestResults(db);
      expect(results.length).toBeGreaterThan(0);
    });

    test('getVisualTestResults with combined filters', () => {
      insertVisualTestResult(db, {
        testRunId,
        page: 'home',
        device: 'desktop',
        baselineRef: null,
        currentRef: '/current/home.png',
        diffRef: null,
        diffPercentage: 0,
        aiAnalysis: null,
        severity: null,
        status: 'passed',
        timestamp: new Date()
      });

      insertVisualTestResult(db, {
        testRunId,
        page: 'about',
        device: 'mobile',
        baselineRef: null,
        currentRef: '/current/about.png',
        diffRef: null,
        diffPercentage: 0,
        aiAnalysis: null,
        severity: null,
        status: 'failed',
        timestamp: new Date()
      });

      const results = getVisualTestResults(db, {
        testRunId,
        page: 'home',
        status: 'passed',
        limit: 10
      });

      expect(results).toHaveLength(1);
      expect(results[0].page).toBe('home');
      expect(results[0].status).toBe('passed');
    });

    test('getA11yTestResults with combined filters', () => {
      insertA11yTestResult(db, {
        testRunId,
        page: 'home',
        violationsCritical: 0,
        violationsSerious: 0,
        violationsModerate: 0,
        violationsMinor: 0,
        keyboardPassed: true,
        screenReaderPassed: true,
        score: 100,
        status: 'passed',
        timestamp: new Date()
      });

      insertA11yTestResult(db, {
        testRunId,
        page: 'about',
        violationsCritical: 1,
        violationsSerious: 2,
        violationsModerate: 3,
        violationsMinor: 4,
        keyboardPassed: false,
        screenReaderPassed: false,
        score: 60,
        status: 'failed',
        timestamp: new Date()
      });

      const results = getA11yTestResults(db, {
        testRunId,
        page: 'home',
        status: 'passed',
        limit: 10
      });

      expect(results).toHaveLength(1);
      expect(results[0].page).toBe('home');
      expect(results[0].status).toBe('passed');
    });

    test('getVisualTestStats with zero results returns zeros', () => {
      const newTestRunId = insertTestRun(db, {
        instruction: 'empty test',
        status: 'success',
        startTime: new Date(),
        endTime: new Date()
      });

      const stats = getVisualTestStats(db, newTestRunId);
      expect(stats.total).toBe(0);
      expect(stats.passed).toBe(0);
      expect(stats.failed).toBe(0);
      expect(stats.newBaselines).toBe(0);
    });

    test('getA11yTestStats with zero results returns zeros', () => {
      const newTestRunId = insertTestRun(db, {
        instruction: 'empty test',
        status: 'success',
        startTime: new Date(),
        endTime: new Date()
      });

      const stats = getA11yTestStats(db, newTestRunId);
      expect(stats.total).toBe(0);
      expect(stats.passed).toBe(0);
      expect(stats.failed).toBe(0);
      expect(stats.warnings).toBe(0);
      expect(stats.totalViolations.critical).toBe(0);
      expect(stats.totalViolations.serious).toBe(0);
      expect(stats.totalViolations.moderate).toBe(0);
      expect(stats.totalViolations.minor).toBe(0);
    });
  });
});
