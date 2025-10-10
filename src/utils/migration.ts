import Database from 'better-sqlite3';
import { createLogger } from './types';

const logger = createLogger('MigrationRunner');

export interface Migration {
  version: string;
  description: string;
  up: (db: Database.Database) => void;
  down?: (db: Database.Database) => void;
}

export class MigrationRunner {
  constructor(private db: Database.Database) {
    this.initializeVersioning();
  }

  private initializeVersioning(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version TEXT PRIMARY KEY,
        description TEXT,
        applied_at INTEGER NOT NULL
      )
    `);

    // Ensure Phase 1 baseline is recorded
    const currentVersion = this.getCurrentVersion();
    if (!currentVersion || currentVersion === '000') {
      this.db.prepare(`
        INSERT OR REPLACE INTO schema_version (version, description, applied_at)
        VALUES (?, ?, ?)
      `).run('001', 'Phase 1 Foundation - CLI, Browser, AI Integration', Date.now());
    }
  }

  getCurrentVersion(): string {
    const result = this.db.prepare(`
      SELECT version FROM schema_version ORDER BY version DESC LIMIT 1
    `).get() as { version: string } | undefined;
    return result?.version || '000';
  }

  async runMigrations(): Promise<void> {
    const currentVersion = this.getCurrentVersion();
    const migrations = this.getMigrations();

    for (const migration of migrations) {
      if (migration.version > currentVersion) {
        logger.info(`Running migration ${migration.version}: ${migration.description}`);

        const transaction = this.db.transaction(() => {
          migration.up(this.db);
          this.db.prepare(`
            INSERT INTO schema_version (version, description, applied_at)
            VALUES (?, ?, ?)
          `).run(migration.version, migration.description, Date.now());
        });

        try {
          transaction();
          logger.info(`Migration ${migration.version} completed successfully`);
        } catch (error) {
          logger.error(`Migration ${migration.version} failed`, error instanceof Error ? error : new Error(String(error)));
          throw error;
        }
      }
    }
  }

  private getMigrations(): Migration[] {
    return [
      {
        version: '002',
        description: 'Phase 2 Extensions - Visual Regression & Accessibility',
        up: (db: Database.Database) => {
          // Visual baselines table
          db.exec(`
            CREATE TABLE IF NOT EXISTS visual_baselines (
              id TEXT PRIMARY KEY,
              branch TEXT NOT NULL,
              test_name TEXT NOT NULL,
              url TEXT NOT NULL,
              selector TEXT,
              viewport_width INTEGER NOT NULL,
              viewport_height INTEGER NOT NULL,
              element TEXT,
              device TEXT,
              path TEXT NOT NULL,
              hash TEXT NOT NULL,
              config_json TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              git_commit TEXT,
              git_author TEXT,
              UNIQUE(branch, test_name, url, selector, viewport_width, viewport_height, device)
            )
          `);

          // Visual comparisons table
          db.exec(`
            CREATE TABLE IF NOT EXISTS visual_comparisons (
              id TEXT PRIMARY KEY,
              run_id TEXT,
              baseline_id TEXT NOT NULL,
              test_name TEXT NOT NULL,
              url TEXT NOT NULL,
              similarity REAL NOT NULL,
              pixel_difference INTEGER NOT NULL,
              threshold REAL NOT NULL,
              passed BOOLEAN NOT NULL,
              screenshot_path TEXT NOT NULL,
              diff_path TEXT,
              viewport_width INTEGER NOT NULL,
              viewport_height INTEGER NOT NULL,
              device TEXT,
              timestamp INTEGER NOT NULL,
              ai_analysis_json TEXT,
              regions_json TEXT,
              metadata_json TEXT,
              FOREIGN KEY (baseline_id) REFERENCES visual_baselines (id),
              FOREIGN KEY (run_id) REFERENCES test_results (id)
            )
          `);

          // Visual reports table
          db.exec(`
            CREATE TABLE IF NOT EXISTS visual_reports (
              id TEXT PRIMARY KEY,
              test_suite TEXT NOT NULL,
              branch TEXT NOT NULL,
              timestamp INTEGER NOT NULL,
              total_tests INTEGER NOT NULL,
              passed_tests INTEGER NOT NULL,
              failed_tests INTEGER NOT NULL,
              new_baselines INTEGER NOT NULL,
              report_path TEXT NOT NULL,
              format TEXT NOT NULL,
              git_commit TEXT,
              git_author TEXT,
              environment_json TEXT
            )
          `);

          // Accessibility results table
          db.exec(`
            CREATE TABLE IF NOT EXISTS a11y_results (
              id TEXT PRIMARY KEY,
              run_id TEXT,
              test_name TEXT NOT NULL,
              url TEXT NOT NULL,
              timestamp INTEGER NOT NULL,
              passed BOOLEAN NOT NULL,
              violations_count INTEGER NOT NULL,
              critical_violations INTEGER NOT NULL,
              serious_violations INTEGER NOT NULL,
              moderate_violations INTEGER NOT NULL,
              minor_violations INTEGER NOT NULL,
              passes_count INTEGER NOT NULL,
              incomplete_count INTEGER NOT NULL,
              inapplicable_count INTEGER NOT NULL,
              axe_version TEXT NOT NULL,
              wcag_level TEXT NOT NULL,
              violations_json TEXT,
              passes_json TEXT,
              incomplete_json TEXT,
              metadata_json TEXT,
              FOREIGN KEY (run_id) REFERENCES test_results (id)
            )
          `);

          // Keyboard navigation results table
          db.exec(`
            CREATE TABLE IF NOT EXISTS keyboard_test_results (
              id TEXT PRIMARY KEY,
              run_id TEXT,
              test_name TEXT NOT NULL,
              timestamp INTEGER NOT NULL,
              passed BOOLEAN NOT NULL,
              interactions_json TEXT NOT NULL,
              focus_order_json TEXT NOT NULL,
              trap_tests_json TEXT NOT NULL,
              metadata_json TEXT,
              FOREIGN KEY (run_id) REFERENCES test_results (id)
            )
          `);

          // Screen reader simulation results table
          db.exec(`
            CREATE TABLE IF NOT EXISTS screenreader_test_results (
              id TEXT PRIMARY KEY,
              run_id TEXT,
              test_name TEXT NOT NULL,
              timestamp INTEGER NOT NULL,
              passed BOOLEAN NOT NULL,
              announcements_json TEXT NOT NULL,
              landmark_structure_json TEXT NOT NULL,
              heading_structure_json TEXT NOT NULL,
              metadata_json TEXT,
              FOREIGN KEY (run_id) REFERENCES test_results (id)
            )
          `);

          // Accessibility reports table
          db.exec(`
            CREATE TABLE IF NOT EXISTS a11y_reports (
              id TEXT PRIMARY KEY,
              test_suite TEXT NOT NULL,
              timestamp INTEGER NOT NULL,
              total_tests INTEGER NOT NULL,
              passed_tests INTEGER NOT NULL,
              failed_tests INTEGER NOT NULL,
              critical_violations INTEGER NOT NULL,
              serious_violations INTEGER NOT NULL,
              moderate_violations INTEGER NOT NULL,
              minor_violations INTEGER NOT NULL,
              report_path TEXT NOT NULL,
              format TEXT NOT NULL,
              environment_json TEXT
            )
          `);

          // Performance metrics table
          db.exec(`
            CREATE TABLE IF NOT EXISTS performance_metrics (
              id TEXT PRIMARY KEY,
              run_id TEXT,
              test_name TEXT NOT NULL,
              url TEXT NOT NULL,
              timestamp INTEGER NOT NULL,
              load_event_end REAL,
              dom_content_loaded_event_end REAL,
              first_contentful_paint REAL,
              largest_contentful_paint REAL,
              time_to_interactive REAL,
              cumulative_layout_shift REAL,
              first_input_delay REAL,
              metrics_json TEXT,
              resources_json TEXT,
              FOREIGN KEY (run_id) REFERENCES test_results (id)
            )
          `);

          // Extend existing test_results table for Phase 2
          db.exec(`
            ALTER TABLE test_results
            ADD COLUMN visual_enabled BOOLEAN DEFAULT FALSE
          `);

          db.exec(`
            ALTER TABLE test_results
            ADD COLUMN a11y_enabled BOOLEAN DEFAULT FALSE
          `);

          db.exec(`
            ALTER TABLE test_results
            ADD COLUMN performance_enabled BOOLEAN DEFAULT FALSE
          `);

          db.exec(`
            ALTER TABLE test_results
            ADD COLUMN baseline_reference TEXT
          `);

          db.exec(`
            ALTER TABLE test_results
            ADD COLUMN git_branch TEXT
          `);

          db.exec(`
            ALTER TABLE test_results
            ADD COLUMN git_commit TEXT
          `);

          // Create indexes for better query performance
          db.exec(`CREATE INDEX IF NOT EXISTS idx_visual_baselines_branch ON visual_baselines (branch)`);
          db.exec(`CREATE INDEX IF NOT EXISTS idx_visual_baselines_test_name ON visual_baselines (test_name)`);
          db.exec(`CREATE INDEX IF NOT EXISTS idx_visual_comparisons_run_id ON visual_comparisons (run_id)`);
          db.exec(`CREATE INDEX IF NOT EXISTS idx_visual_comparisons_passed ON visual_comparisons (passed)`);
          db.exec(`CREATE INDEX IF NOT EXISTS idx_a11y_results_run_id ON a11y_results (run_id)`);
          db.exec(`CREATE INDEX IF NOT EXISTS idx_a11y_results_passed ON a11y_results (passed)`);
          db.exec(`CREATE INDEX IF NOT EXISTS idx_performance_metrics_run_id ON performance_metrics (run_id)`);
          db.exec(`CREATE INDEX IF NOT EXISTS idx_test_results_visual_enabled ON test_results (visual_enabled)`);
          db.exec(`CREATE INDEX IF NOT EXISTS idx_test_results_a11y_enabled ON test_results (a11y_enabled)`);
          db.exec(`CREATE INDEX IF NOT EXISTS idx_test_results_git_branch ON test_results (git_branch)`);
        },
        down: (db: Database.Database) => {
          // Rollback Phase 2 tables (destructive operation)
          db.exec(`DROP TABLE IF EXISTS performance_metrics`);
          db.exec(`DROP TABLE IF EXISTS screenreader_test_results`);
          db.exec(`DROP TABLE IF EXISTS keyboard_test_results`);
          db.exec(`DROP TABLE IF EXISTS a11y_reports`);
          db.exec(`DROP TABLE IF EXISTS a11y_results`);
          db.exec(`DROP TABLE IF EXISTS visual_reports`);
          db.exec(`DROP TABLE IF EXISTS visual_comparisons`);
          db.exec(`DROP TABLE IF EXISTS visual_baselines`);

          // Note: Cannot easily remove columns from SQLite without recreating table
          // This would be destructive to Phase 1 data, so we leave the columns
          logger.warn('Phase 2 rollback: Cannot remove added columns from test_results table without data loss');
        }
      }
    ];
  }
}

// Utility function to apply migrations to an existing database
export async function applyPhase2Migration(dbPath: string): Promise<void> {
  const db = new Database(dbPath);
  const migrationRunner = new MigrationRunner(db);

  try {
    await migrationRunner.runMigrations();
    logger.info('Phase 2 database migration completed successfully');
  } catch (error) {
    logger.error('Phase 2 database migration failed', error instanceof Error ? error : new Error(String(error)));
    throw error;
  } finally {
    db.close();
  }
}

// Export the migration for use in tests
export const Phase2Migration: Migration = {
  version: '002',
  description: 'Phase 2 Extensions - Visual Regression & Accessibility',
  up: (db: Database.Database) => {
    const migrationRunner = new MigrationRunner(db);
    const migrations = migrationRunner['getMigrations']();
    const phase2Migration = migrations.find(m => m.version === '002');
    if (phase2Migration) {
      phase2Migration.up(db);
    }
  }
};