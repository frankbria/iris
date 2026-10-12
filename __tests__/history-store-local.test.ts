/**
 * The local SQLite history store: transactions, ordering and file handling (issue #356),
 * on real database files.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { getTestRuns, getVisualTestResults, initializeDatabase, insertTestRun } from '../src/db';
import { recordSqliteRun, sqliteHistoryStore, type RunInput } from '../src/history-store';
import { AIVisionCache } from '../src/ai-client/cache';
import { CostTracker } from '../src/ai-client/cost-tracker';
import type { VisualTestResult } from '../src/visual/visual-runner';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-356-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const comparison = (page: string) => ({
  page,
  device: 'desktop',
  passed: true,
  similarity: 1,
  pixelDifference: 0,
  threshold: 0.1,
  screenshotPath: `/tmp/${page}.png`,
});

function visualRun(pages: string[]): RunInput {
  const result = {
    summary: {
      totalComparisons: pages.length,
      passed: pages.length,
      failed: 0,
      newBaselines: 0,
      overallStatus: 'passed',
      severityCounts: {},
    },
    results: pages.map(comparison),
  } as unknown as VisualTestResult;
  return { kind: 'visual', result, startedAt: new Date(), finishedAt: new Date() };
}

describe('a run is recorded whole or not at all (#356)', () => {
  it('leaves no run and no results when a result row fails', () => {
    const db = initializeDatabase(path.join(dir, 'h.db'));
    try {
      // The second comparison violates NOT NULL (page), after the run row and the first
      // result were written.
      const run = visualRun(['/home', null as unknown as string]);
      expect(() => recordSqliteRun(db, run)).toThrow(/NOT NULL/);
      expect(getTestRuns(db)).toEqual([]);
      expect(db.prepare('SELECT count(*) AS n FROM visual_test_results').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it('records a good run with all its results', () => {
    const db = initializeDatabase(path.join(dir, 'h.db'));
    try {
      const id = recordSqliteRun(db, visualRun(['/a', '/b', '/c']));
      expect(getVisualTestResults(db, { testRunId: id })).toHaveLength(3);
    } finally {
      db.close();
    }
  });
});

describe('ordering is deterministic (#356)', () => {
  it('breaks created_at ties newest first by id', () => {
    const db = initializeDatabase(path.join(dir, 'h.db'));
    try {
      for (const instruction of ['first', 'second', 'third']) {
        insertTestRun(db, { instruction, status: 'success', startTime: new Date() });
      }
      // One-second resolution: rows written together tie on created_at.
      db.prepare("UPDATE test_results SET created_at = '2026-10-01 00:00:00'").run();
      expect(getTestRuns(db).map((r) => r.instruction)).toEqual(['third', 'second', 'first']);
      expect(getTestRuns(db, 2).map((r) => r.instruction)).toEqual(['third', 'second']);
    } finally {
      db.close();
    }
  });

  it('lists the newest runs past rows that are not runs, and reads any run by id', async () => {
    const file = path.join(dir, 'h.db');
    const store = sqliteHistoryStore(file);
    const oldest = await store.record(visualRun(['/old']));
    const db = initializeDatabase(file);
    for (let i = 0; i < 30; i++) {
      insertTestRun(db, { instruction: `click #b${i}`, status: 'success', startTime: new Date() });
    }
    db.close();
    const newest = await store.record(visualRun(['/new']));

    expect((await store.list({ limit: 1 })).map((r) => r.id)).toEqual([newest]);
    expect((await store.list()).map((r) => r.id)).toEqual([newest, oldest]);
    expect((await store.get(oldest))?.results.map((r) => r.url)).toEqual(['/old']);
    // Codex review: a zero limit is no runs, as before and as the hosted store.
    expect(await store.list({ limit: 0 })).toEqual([]);
    expect(await store.get('999999')).toBeNull();
    expect(await store.get('not-a-number')).toBeNull();
  });
});

describe('database files are private to their owner (#356)', () => {
  const mode = (file: string) => fs.statSync(file).mode & 0o777;

  it.each([
    ['history', (file: string) => initializeDatabase(file).close()],
    ['vision cache', (file: string) => new AIVisionCache({ dbPath: file }).close()],
    ['cost ledger', (file: string) => new CostTracker(file).close()],
  ])('creates the %s file 0600, even in an existing open directory', (_what, open) => {
    const shared = path.join(dir, 'data');
    fs.mkdirSync(shared, { mode: 0o755 });
    fs.chmodSync(shared, 0o755);
    const file = path.join(shared, 'x.db');

    open(file);

    expect(mode(file)).toBe(0o600);
  });

  // Codex review: '' is better-sqlite3's anonymous temporary database, like ':memory:'.
  it.each(['', ':memory:'])('opens a database with no file (%p) without creating one', (file) => {
    const db = initializeDatabase(file);
    try {
      expect(getTestRuns(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('leaves the mode of an existing file alone', () => {
    const file = path.join(dir, 'mine.db');
    initializeDatabase(file).close();
    fs.chmodSync(file, 0o640);

    initializeDatabase(file).close();

    expect(mode(file)).toBe(0o640);
  });
});
