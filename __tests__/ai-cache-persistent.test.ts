/**
 * The vision cache's persistent tier read back (#325): a verdict written by one process is
 * served to the next from SQLite, an expired row is a miss and goes, and a row that is not a
 * valid verdict (written by an older release, or damaged) is a miss and goes, never served.
 * Real SQLite files; each case opens a fresh instance, so the memory tier is empty.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { AIVisionCache } from '../src/ai-client/cache';

const verdict = {
  severity: 'minor' as const,
  confidence: 0.9,
  reasoning: 'button moved',
  categories: ['layout' as const],
};

describe('vision cache persistent tier (#325)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-cache-disk-'));
    dbPath = path.join(dir, 'vision-cache.db');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Writes `verdict` under a key from a first instance, then closes it. */
  const writeOnce = () => {
    const first = new AIVisionCache({ dbPath });
    const key = first.generateKey('base', 'cur', 'anthropic', 'claude-sonnet-5');
    first.set(key, verdict, 'anthropic', 'claude-sonnet-5');
    first.close();
    return key;
  };

  const rows = () => {
    const db = new Database(dbPath);
    try {
      return (db.prepare('SELECT COUNT(*) AS n FROM ai_vision_cache').get() as { n: number }).n;
    } finally {
      db.close();
    }
  };

  it('serves a verdict written by an earlier instance, from disk', () => {
    const key = writeOnce();
    const second = new AIVisionCache({ dbPath });
    try {
      expect(second.get(key)).toEqual(verdict);
      expect(second.getStats().hits).toBe(1);
    } finally {
      second.close();
    }
  });

  it('treats an expired row as a miss and deletes it', () => {
    const key = writeOnce();
    const db = new Database(dbPath);
    db.prepare('UPDATE ai_vision_cache SET timestamp = ?').run(Date.now() - 60_000);
    db.close();
    const second = new AIVisionCache({ dbPath, ttlMs: 1_000, pruneIntervalWrites: 0 });
    try {
      expect(second.get(key)).toBeUndefined();
      expect(second.getStats().misses).toBe(1);
    } finally {
      second.close();
    }
    expect(rows()).toBe(0);
  });

  it.each([
    ['not JSON', '{severity: minor'],
    ['JSON of the wrong shape', JSON.stringify({ severity: 'catastrophic', confidence: 2 })],
  ])('treats a row that is %s as a miss and deletes it, never serving it', (_what, raw) => {
    const key = writeOnce();
    const db = new Database(dbPath);
    db.prepare('UPDATE ai_vision_cache SET value = ?').run(raw);
    db.close();
    const second = new AIVisionCache({ dbPath });
    try {
      expect(second.get(key)).toBeUndefined();
      expect(second.getStats().misses).toBe(1);
    } finally {
      second.close();
    }
    expect(rows()).toBe(0);
  });
});
