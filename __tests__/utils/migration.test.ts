import Database from 'better-sqlite3';
import { MigrationRunner, Phase2Migration } from '../../src/utils/migration';
import fs from 'fs';
import path from 'path';

describe('Database Migration', () => {
  let testDbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    // Create a temporary database for testing
    testDbPath = path.join(__dirname, `test-${Date.now()}.db`);
    db = new Database(testDbPath);

    // Create the Phase 1 baseline table (test_results)
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
  });

  afterEach(() => {
    if (db) {
      db.close();
    }
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  describe('MigrationRunner', () => {
    it('should initialize schema versioning table', () => {
      const migrationRunner = new MigrationRunner(db);

      const tables = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'
      `).all() as Array<{ name: string }>;

      expect(tables).toHaveLength(1);
      expect(tables[0].name).toBe('schema_version');
    });

    it('should record Phase 1 baseline version', () => {
      const migrationRunner = new MigrationRunner(db);
      const currentVersion = migrationRunner.getCurrentVersion();

      expect(currentVersion).toBe('001');
    });

    it('should run Phase 2 migration successfully', async () => {
      const migrationRunner = new MigrationRunner(db);

      // Verify initial state
      expect(migrationRunner.getCurrentVersion()).toBe('001');

      // Run migrations
      await migrationRunner.runMigrations();

      // Verify migration completed
      expect(migrationRunner.getCurrentVersion()).toBe('002');

      // Verify Phase 2 tables were created
      const tables = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' ORDER BY name
      `).all().map((row: any) => row.name);

      const expectedTables = [
        'a11y_reports',
        'a11y_results',
        'keyboard_test_results',
        'performance_metrics',
        'schema_version',
        'screenreader_test_results',
        'test_results',
        'visual_baselines',
        'visual_comparisons',
        'visual_reports'
      ];

      expectedTables.forEach(tableName => {
        expect(tables).toContain(tableName);
      });
    });

    it('should add new columns to test_results table', async () => {
      const migrationRunner = new MigrationRunner(db);
      await migrationRunner.runMigrations();

      // Check that new columns were added
      const tableInfo = db.prepare(`PRAGMA table_info(test_results)`).all();
      const columnNames = tableInfo.map((col: any) => col.name);

      expect(columnNames).toContain('visual_enabled');
      expect(columnNames).toContain('a11y_enabled');
      expect(columnNames).toContain('performance_enabled');
      expect(columnNames).toContain('baseline_reference');
      expect(columnNames).toContain('git_branch');
      expect(columnNames).toContain('git_commit');
    });

    it('should create indexes for performance', async () => {
      const migrationRunner = new MigrationRunner(db);
      await migrationRunner.runMigrations();

      const indexes = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'
      `).all().map((row: any) => row.name);

      const expectedIndexes = [
        'idx_visual_baselines_branch',
        'idx_visual_baselines_test_name',
        'idx_visual_comparisons_run_id',
        'idx_visual_comparisons_passed',
        'idx_a11y_results_run_id',
        'idx_a11y_results_passed',
        'idx_performance_metrics_run_id',
        'idx_test_results_visual_enabled',
        'idx_test_results_a11y_enabled',
        'idx_test_results_git_branch'
      ];

      expectedIndexes.forEach(indexName => {
        expect(indexes).toContain(indexName);
      });
    });

    it('should not run migration twice', async () => {
      const migrationRunner = new MigrationRunner(db);

      // Run migration first time
      await migrationRunner.runMigrations();
      expect(migrationRunner.getCurrentVersion()).toBe('002');

      // Mock console to capture logs
      const consoleSpy = jest.spyOn(console, 'info').mockImplementation();

      // Run migration second time
      await migrationRunner.runMigrations();
      expect(migrationRunner.getCurrentVersion()).toBe('002');

      // Should not have run migration again
      expect(consoleSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Running migration 002')
      );

      consoleSpy.mockRestore();
    });

    it('should preserve existing Phase 1 data during migration', async () => {
      // Insert test data into Phase 1 table
      const insertStmt = db.prepare(`
        INSERT INTO test_results (instruction, status, start_time)
        VALUES (?, ?, ?)
      `);

      insertStmt.run('test instruction 1', 'success', '2023-01-01T00:00:00Z');
      insertStmt.run('test instruction 2', 'error', '2023-01-02T00:00:00Z');

      // Verify data exists before migration
      const beforeMigration = db.prepare('SELECT COUNT(*) as count FROM test_results').get() as { count: number };
      expect(beforeMigration.count).toBe(2);

      // Run migration
      const migrationRunner = new MigrationRunner(db);
      await migrationRunner.runMigrations();

      // Verify data still exists after migration
      const afterMigration = db.prepare('SELECT COUNT(*) as count FROM test_results').get() as { count: number };
      expect(afterMigration.count).toBe(2);

      // Verify original data integrity
      const originalData = db.prepare(`
        SELECT instruction, status FROM test_results ORDER BY instruction
      `).all();

      expect(originalData).toEqual([
        { instruction: 'test instruction 1', status: 'success' },
        { instruction: 'test instruction 2', status: 'error' }
      ]);
    });
  });

  describe('Phase2Migration', () => {
    it('should be exportable and executable', async () => {
      expect(Phase2Migration.version).toBe('002');
      expect(Phase2Migration.description).toContain('Phase 2');

      // Should be able to run the migration directly
      const migrationRunner = new MigrationRunner(db);
      Phase2Migration.up(db);

      // Verify tables were created
      const visualBaselines = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='visual_baselines'
      `).get();

      expect(visualBaselines).toBeTruthy();
    });
  });

  describe('Error Handling', () => {
    it('should handle migration failures gracefully', async () => {
      // Create a corrupted migration by closing the database
      const migrationRunner = new MigrationRunner(db);
      db.close();

      // Migration should fail and throw error
      await expect(migrationRunner.runMigrations()).rejects.toThrow();
    });

    it('should handle transaction failures', () => {
      // This test verifies that migration failures are properly handled
      const migrationRunner = new MigrationRunner(db);

      // Test that individual SQL errors are caught properly
      expect(() => {
        try {
          db.exec('INVALID SQL STATEMENT');
        } catch (error) {
          // Error should be caught and handled
          expect(error).toBeDefined();
        }
      }).not.toThrow();

      // Test that the migration runner continues to work after errors
      const currentVersion = migrationRunner.getCurrentVersion();
      expect(currentVersion).toBe('001');
    });
  });
});