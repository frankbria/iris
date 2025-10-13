import Database from 'better-sqlite3';

export interface TestRun {
  id?: number;
  instruction: string;
  status: 'success' | 'error' | 'pending';
  startTime: Date;
  endTime?: Date;
}

export interface VisualTestResult {
  id?: number;
  testRunId: number;
  page: string;
  device: string;
  baselineRef: string | null;
  currentRef: string;
  diffRef: string | null;
  diffPercentage: number;
  aiAnalysis: string | null;
  severity: 'low' | 'medium' | 'high' | 'critical' | null;
  status: 'passed' | 'failed' | 'new_baseline';
  timestamp: Date;
}

export interface A11yTestResult {
  id?: number;
  testRunId: number;
  page: string;
  violationsCritical: number;
  violationsSerious: number;
  violationsModerate: number;
  violationsMinor: number;
  keyboardPassed: boolean;
  screenReaderPassed: boolean;
  score: number;
  status: 'passed' | 'failed' | 'warning';
  timestamp: Date;
}

const SCHEMA_VERSION = 1;

/**
 * Initialize SQLite database and create all tables if they don't exist.
 */
export function initializeDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  // Enable foreign keys
  db.pragma('foreign_keys = ON');

  // Create schema_version table
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Check current schema version
  const versionRow = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as { version: number } | undefined;
  const currentVersion = versionRow?.version || 0;

  // Apply migrations
  if (currentVersion < 1) {
    applyMigrationV1(db);
  }

  return db;
}

/**
 * Apply migration version 1: Create initial tables
 */
function applyMigrationV1(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS test_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instruction TEXT NOT NULL,
      status TEXT CHECK(status IN ('success', 'error', 'pending')) NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS visual_test_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      test_run_id INTEGER NOT NULL,
      page TEXT NOT NULL,
      device TEXT NOT NULL,
      baseline_ref TEXT,
      current_ref TEXT NOT NULL,
      diff_ref TEXT,
      diff_percentage REAL NOT NULL,
      ai_analysis TEXT,
      severity TEXT CHECK(severity IN ('low', 'medium', 'high', 'critical')),
      status TEXT CHECK(status IN ('passed', 'failed', 'new_baseline')) NOT NULL,
      timestamp TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (test_run_id) REFERENCES test_results(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS a11y_test_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      test_run_id INTEGER NOT NULL,
      page TEXT NOT NULL,
      violations_critical INTEGER NOT NULL DEFAULT 0,
      violations_serious INTEGER NOT NULL DEFAULT 0,
      violations_moderate INTEGER NOT NULL DEFAULT 0,
      violations_minor INTEGER NOT NULL DEFAULT 0,
      keyboard_passed INTEGER NOT NULL DEFAULT 0,
      screen_reader_passed INTEGER NOT NULL DEFAULT 0,
      score REAL NOT NULL,
      status TEXT CHECK(status IN ('passed', 'failed', 'warning')) NOT NULL,
      timestamp TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (test_run_id) REFERENCES test_results(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_visual_test_run_id ON visual_test_results(test_run_id);
    CREATE INDEX IF NOT EXISTS idx_visual_page ON visual_test_results(page);
    CREATE INDEX IF NOT EXISTS idx_visual_status ON visual_test_results(status);
    CREATE INDEX IF NOT EXISTS idx_a11y_test_run_id ON a11y_test_results(test_run_id);
    CREATE INDEX IF NOT EXISTS idx_a11y_page ON a11y_test_results(page);
    CREATE INDEX IF NOT EXISTS idx_a11y_status ON a11y_test_results(status);

    INSERT INTO schema_version (version) VALUES (1);
  `);
}

/**
 * Insert a test run record into the database.
 */
export function insertTestRun(db: Database.Database, testRun: TestRun): number {
  const stmt = db.prepare(`
    INSERT INTO test_results (instruction, status, start_time, end_time)
    VALUES (?, ?, ?, ?)
  `);

  const result = stmt.run(
    testRun.instruction,
    testRun.status,
    testRun.startTime.toISOString(),
    testRun.endTime?.toISOString() || null
  );

  return result.lastInsertRowid as number;
}

/**
 * Get test run records from the database.
 */
export function getTestRuns(db: Database.Database, limit?: number): TestRun[] {
  const query = limit
    ? 'SELECT * FROM test_results ORDER BY created_at DESC LIMIT ?'
    : 'SELECT * FROM test_results ORDER BY created_at DESC';

  const stmt = db.prepare(query);
  const rows = limit ? stmt.all(limit) : stmt.all();

  return rows.map((row: any) => ({
    id: row.id,
    instruction: row.instruction,
    status: row.status,
    startTime: new Date(row.start_time),
    endTime: row.end_time ? new Date(row.end_time) : undefined
  }));
}

/**
 * Insert a visual test result into the database.
 */
export function insertVisualTestResult(db: Database.Database, result: VisualTestResult): number {
  const stmt = db.prepare(`
    INSERT INTO visual_test_results (
      test_run_id, page, device, baseline_ref, current_ref, diff_ref,
      diff_percentage, ai_analysis, severity, status, timestamp
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertResult = stmt.run(
    result.testRunId,
    result.page,
    result.device,
    result.baselineRef,
    result.currentRef,
    result.diffRef,
    result.diffPercentage,
    result.aiAnalysis,
    result.severity,
    result.status,
    result.timestamp.toISOString()
  );

  return insertResult.lastInsertRowid as number;
}

/**
 * Get visual test results from the database.
 */
export function getVisualTestResults(
  db: Database.Database,
  options?: {
    testRunId?: number;
    page?: string;
    status?: 'passed' | 'failed' | 'new_baseline';
    limit?: number;
  }
): VisualTestResult[] {
  let query = 'SELECT * FROM visual_test_results WHERE 1=1';
  const params: any[] = [];

  if (options?.testRunId !== undefined) {
    query += ' AND test_run_id = ?';
    params.push(options.testRunId);
  }

  if (options?.page) {
    query += ' AND page = ?';
    params.push(options.page);
  }

  if (options?.status) {
    query += ' AND status = ?';
    params.push(options.status);
  }

  query += ' ORDER BY created_at DESC';

  if (options?.limit) {
    query += ' LIMIT ?';
    params.push(options.limit);
  }

  const stmt = db.prepare(query);
  const rows = stmt.all(...params);

  return rows.map((row: any) => ({
    id: row.id,
    testRunId: row.test_run_id,
    page: row.page,
    device: row.device,
    baselineRef: row.baseline_ref,
    currentRef: row.current_ref,
    diffRef: row.diff_ref,
    diffPercentage: row.diff_percentage,
    aiAnalysis: row.ai_analysis,
    severity: row.severity,
    status: row.status,
    timestamp: new Date(row.timestamp)
  }));
}

/**
 * Insert an accessibility test result into the database.
 */
export function insertA11yTestResult(db: Database.Database, result: A11yTestResult): number {
  const stmt = db.prepare(`
    INSERT INTO a11y_test_results (
      test_run_id, page, violations_critical, violations_serious,
      violations_moderate, violations_minor, keyboard_passed,
      screen_reader_passed, score, status, timestamp
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertResult = stmt.run(
    result.testRunId,
    result.page,
    result.violationsCritical,
    result.violationsSerious,
    result.violationsModerate,
    result.violationsMinor,
    result.keyboardPassed ? 1 : 0,
    result.screenReaderPassed ? 1 : 0,
    result.score,
    result.status,
    result.timestamp.toISOString()
  );

  return insertResult.lastInsertRowid as number;
}

/**
 * Get accessibility test results from the database.
 */
export function getA11yTestResults(
  db: Database.Database,
  options?: {
    testRunId?: number;
    page?: string;
    status?: 'passed' | 'failed' | 'warning';
    limit?: number;
  }
): A11yTestResult[] {
  let query = 'SELECT * FROM a11y_test_results WHERE 1=1';
  const params: any[] = [];

  if (options?.testRunId !== undefined) {
    query += ' AND test_run_id = ?';
    params.push(options.testRunId);
  }

  if (options?.page) {
    query += ' AND page = ?';
    params.push(options.page);
  }

  if (options?.status) {
    query += ' AND status = ?';
    params.push(options.status);
  }

  query += ' ORDER BY created_at DESC';

  if (options?.limit) {
    query += ' LIMIT ?';
    params.push(options.limit);
  }

  const stmt = db.prepare(query);
  const rows = stmt.all(...params);

  return rows.map((row: any) => ({
    id: row.id,
    testRunId: row.test_run_id,
    page: row.page,
    violationsCritical: row.violations_critical,
    violationsSerious: row.violations_serious,
    violationsModerate: row.violations_moderate,
    violationsMinor: row.violations_minor,
    keyboardPassed: row.keyboard_passed === 1,
    screenReaderPassed: row.screen_reader_passed === 1,
    score: row.score,
    status: row.status,
    timestamp: new Date(row.timestamp)
  }));
}

/**
 * Get visual test result statistics for a test run.
 */
export function getVisualTestStats(db: Database.Database, testRunId: number): {
  total: number;
  passed: number;
  failed: number;
  newBaselines: number;
} {
  const stmt = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END) as passed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN status = 'new_baseline' THEN 1 ELSE 0 END) as new_baselines
    FROM visual_test_results
    WHERE test_run_id = ?
  `);

  const result = stmt.get(testRunId) as any;

  return {
    total: result.total || 0,
    passed: result.passed || 0,
    failed: result.failed || 0,
    newBaselines: result.new_baselines || 0
  };
}

/**
 * Get accessibility test result statistics for a test run.
 */
export function getA11yTestStats(db: Database.Database, testRunId: number): {
  total: number;
  passed: number;
  failed: number;
  warnings: number;
  totalViolations: {
    critical: number;
    serious: number;
    moderate: number;
    minor: number;
  };
} {
  const stmt = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END) as passed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN status = 'warning' THEN 1 ELSE 0 END) as warnings,
      SUM(violations_critical) as total_critical,
      SUM(violations_serious) as total_serious,
      SUM(violations_moderate) as total_moderate,
      SUM(violations_minor) as total_minor
    FROM a11y_test_results
    WHERE test_run_id = ?
  `);

  const result = stmt.get(testRunId) as any;

  return {
    total: result.total || 0,
    passed: result.passed || 0,
    failed: result.failed || 0,
    warnings: result.warnings || 0,
    totalViolations: {
      critical: result.total_critical || 0,
      serious: result.total_serious || 0,
      moderate: result.total_moderate || 0,
      minor: result.total_minor || 0
    }
  };
}