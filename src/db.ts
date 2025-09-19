import Database from 'better-sqlite3';

export interface TestRun {
  id?: number;
  instruction: string;
  status: 'success' | 'error' | 'pending';
  startTime: Date;
  endTime?: Date;
}

/**
 * Initialize SQLite database and create test_results table if it doesn't exist.
 */
export function initializeDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  // Create test_results table with schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS test_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instruction TEXT NOT NULL,
      status TEXT CHECK(status IN ('success', 'error', 'pending')) NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  return db;
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