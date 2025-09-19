import { initializeDatabase, insertTestRun, getTestRuns, TestRun } from '../src/db';
import * as fs from 'fs';
import * as path from 'path';

describe('Database Module', () => {
  const testDbPath = path.join(__dirname, 'test.db');

  beforeEach(() => {
    // Clean up test database before each test
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  afterEach(() => {
    // Clean up test database after each test
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  test('initializeDatabase creates database and test_results table', () => {
    const db = initializeDatabase(testDbPath);

    // Verify database file was created
    expect(fs.existsSync(testDbPath)).toBe(true);

    // Verify table structure by attempting to insert a record
    const stmt = db.prepare('INSERT INTO test_results (instruction, status, start_time, end_time) VALUES (?, ?, ?, ?)');
    expect(() => stmt.run('test instruction', 'success', new Date().toISOString(), new Date().toISOString())).not.toThrow();

    db.close();
  });

  test('insertTestRun stores test run record correctly', () => {
    const db = initializeDatabase(testDbPath);
    const startTime = new Date();
    const endTime = new Date(startTime.getTime() + 1000);

    const runId = insertTestRun(db, {
      instruction: 'click #button',
      status: 'success',
      startTime,
      endTime
    });

    expect(typeof runId).toBe('number');
    expect(runId).toBeGreaterThan(0);

    db.close();
  });

  test('getTestRuns retrieves test run records', () => {
    const db = initializeDatabase(testDbPath);
    const startTime = new Date();
    const endTime = new Date(startTime.getTime() + 1000);

    // Insert test records
    const id1 = insertTestRun(db, {
      instruction: 'click #button1',
      status: 'success',
      startTime,
      endTime
    });

    const id2 = insertTestRun(db, {
      instruction: 'click #button2',
      status: 'error',
      startTime,
      endTime
    });

    const runs = getTestRuns(db);

    expect(runs).toHaveLength(2);
    // Verify both records exist regardless of order
    const instructions = runs.map(r => r.instruction);
    const statuses = runs.map(r => r.status);

    expect(instructions).toContain('click #button1');
    expect(instructions).toContain('click #button2');
    expect(statuses).toContain('success');
    expect(statuses).toContain('error');

    db.close();
  });

  test('getTestRuns with limit returns correct number of records', () => {
    const db = initializeDatabase(testDbPath);
    const startTime = new Date();
    const endTime = new Date(startTime.getTime() + 1000);

    // Insert 3 test records
    for (let i = 1; i <= 3; i++) {
      insertTestRun(db, {
        instruction: `click #button${i}`,
        status: 'success',
        startTime,
        endTime
      });
    }

    const runs = getTestRuns(db, 2);
    expect(runs).toHaveLength(2);

    db.close();
  });
});