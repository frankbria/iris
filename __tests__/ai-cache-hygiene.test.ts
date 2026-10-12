/**
 * AI cache and ledger hygiene (issue #299), on real SQLite files.
 *
 * - The memory tier served a verdict past its TTL: only the SQLite path checked age, so a
 *   long-running server (`iris connect`, `iris watch`) kept answering from memory forever.
 * - The vision cache and the cost tracker both created `idx_timestamp` and
 *   `idx_provider_model`. Index names are global to a SQLite database, so with both on one
 *   file, `CREATE INDEX IF NOT EXISTS` skipped the second table's indexes silently.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { AIVisionCache } from '../src/ai-client/cache';
import { CostTracker } from '../src/ai-client/cost-tracker';

const VERDICT = {
  severity: 'minor' as const,
  confidence: 0.85,
  reasoning: 'Test change',
  categories: ['color' as const],
};

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-299-'));
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('memory tier TTL (#299)', () => {
  it('serves a fresh entry from memory and refuses an expired one', () => {
    const cache = new AIVisionCache({ dbPath: path.join(dir, 'c.db'), ttlMs: 1000 });
    try {
      const key = cache.generateKey('b', 'c', 'openai', 'gpt-4o');
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now);
      cache.set(key, VERDICT, 'openai', 'gpt-4o');

      // Positive control: inside the TTL, the memory tier answers.
      jest.spyOn(Date, 'now').mockReturnValue(now + 999);
      expect(cache.get(key)).toEqual(VERDICT);

      jest.spyOn(Date, 'now').mockReturnValue(now + 1001);
      expect(cache.get(key)).toBeUndefined();
      expect(cache.getStats().memorySize).toBe(0);
      expect(cache.getStats().misses).toBe(1);
      // Gone from SQLite too: the next process does not get it back either.
      expect(cache.get(key)).toBeUndefined();
    } finally {
      cache.close();
    }
  });
});

describe('distinct index names on a shared database (#299)', () => {
  /** Column lists of every index on `table`, e.g. [['timestamp'], ['provider', 'model']]. */
  function indexedColumns(file: string, table: string): string[][] {
    const db = new Database(file, { readonly: true });
    try {
      const indexes = db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>;
      return indexes.map((i) =>
        (db.prepare(`PRAGMA index_info(${i.name})`).all() as Array<{ name: string }>).map(
          (c) => c.name,
        ),
      );
    } finally {
      db.close();
    }
  }

  // Kimi review: a database made before #299 keeps the old names. Each store drops the
  // legacy index on its own table only: on a shared file, the other table's copy may be
  // that table's only index until its own store opens.
  it("drops the pre-#299 index names on each store's own table only", () => {
    const file = path.join(dir, 'legacy.db');
    const legacy = new Database(file);
    legacy.exec(`
      CREATE TABLE ai_vision_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL,
        timestamp INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, hits INTEGER DEFAULT 0);
      CREATE TABLE cost_tracking (id INTEGER PRIMARY KEY, timestamp INTEGER NOT NULL,
        provider TEXT NOT NULL, model TEXT NOT NULL, operation TEXT NOT NULL, cost REAL NOT NULL);
      CREATE INDEX idx_timestamp ON cost_tracking(timestamp);
      CREATE INDEX idx_provider_model ON ai_vision_cache(provider, model);
    `);
    legacy.close();
    const names = (table: string) => {
      const db = new Database(file, { readonly: true });
      try {
        return (db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>)
          .map((i) => i.name)
          .filter((n) => !n.startsWith('sqlite_'))
          .sort();
      } finally {
        db.close();
      }
    };

    new AIVisionCache({ dbPath: file }).close();
    expect(names('ai_vision_cache')).toEqual([
      'idx_ai_cache_provider_model',
      'idx_ai_cache_timestamp',
    ]);
    expect(names('cost_tracking')).toEqual(['idx_timestamp']); // not the cache's to drop

    new CostTracker(file).close();
    expect(names('cost_tracking')).toEqual([
      'idx_cost_provider_model',
      'idx_cost_timestamp',
      'idx_org_timestamp',
    ]);
  });

  it.each(['cache first', 'tracker first'])('both tables get their indexes (%s)', (order) => {
    const file = path.join(dir, 'shared.db');
    const open = [() => new AIVisionCache({ dbPath: file }), () => new CostTracker(file)];
    if (order === 'tracker first') open.reverse();
    open.map((make) => make()).forEach((store) => store.close());

    for (const table of ['ai_vision_cache', 'cost_tracking']) {
      const columns = indexedColumns(file, table);
      expect(columns).toContainEqual(['timestamp']);
      expect(columns).toContainEqual(['provider', 'model']);
    }
  });
});
