/**
 * The cost ledger and vision cache are scoped per org (#255).
 *
 * Test strategy: real SQLite files under the per-worker IRIS_DATA_DIR. Two
 * trackers (or smart clients) on the SAME ledger and cache file stand in for two
 * tenants of one hosted process, since that is exactly where a process-global sum
 * or key used to leak. The vision vendors are the fake clients the rest of the
 * suite uses (`AIClientFactory.create`), counted per call, because what is under
 * test is which org a call is charged to and which cache entry it may read.
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { CostTracker, BudgetExceededError } from '../src/ai-client/cost-tracker';
import { createSmartClient, SmartAIVisionClient } from '../src/ai-client';
import { AIClientFactory } from '../src/ai-client/factory';
import { ImagePreprocessor } from '../src/ai-client/preprocessor';
import { resolveDataDir } from '../src/data-dir';
import { AIVisualClassifier } from '../src/visual/ai-classifier';
import type { IrisConfig } from '../src/config';

const dir = () => path.join(resolveDataDir(), 'tenant-scope');
const ledger = () => path.join(dir(), 'ledger.db');

beforeEach(() => fs.mkdirSync(dir(), { recursive: true }));
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(dir(), { recursive: true, force: true });
});

/** $2.50 of gpt-4o input. */
const SPEND = { inputTokens: 1_000_000, outputTokens: 0 };

describe('CostTracker scoped to an org', () => {
  it("one org's spend does not trip another org's breaker", () => {
    const a = new CostTracker(ledger(), { dailyLimit: 1 }, { orgId: 'org-a' });
    const b = new CostTracker(ledger(), { dailyLimit: 1 }, { orgId: 'org-b' });
    const local = new CostTracker(ledger(), { dailyLimit: 1 });
    try {
      a.trackOperation('openai', 'gpt-4o', false, SPEND);
      expect(a.getBudgetStatus().circuitBreakerTriggered).toBe(true);
      expect(() => a.reserve('openai', 'gpt-4o')).toThrow(BudgetExceededError);

      expect(b.getBudgetStatus()).toMatchObject({ dailyUsed: 0, circuitBreakerTriggered: false });
      expect(() => b.release(b.reserve('openai', 'gpt-4o'))).not.toThrow();
      // Local mode is its own scope, as before: none of this is its spend.
      expect(local.getBudgetStatus().dailyUsed).toBe(0);
    } finally {
      a.close();
      b.close();
      local.close();
    }
  });

  it('counts reservations in flight per org too', () => {
    // One gpt-4o reservation holds $0.03 (8k in, 1k out), so it fills this budget.
    const a = new CostTracker(ledger(), { dailyLimit: 0.03 }, { orgId: 'org-a' });
    const b = new CostTracker(ledger(), { dailyLimit: 0.03 }, { orgId: 'org-b' });
    try {
      // A reservation holds a call's worst case; org A's holds do not hold back org B.
      a.reserve('openai', 'gpt-4o');
      expect(() => a.reserve('openai', 'gpt-4o')).toThrow(BudgetExceededError);
      expect(() => b.reserve('openai', 'gpt-4o')).not.toThrow();
    } finally {
      a.close();
      b.close();
    }
  });

  it('writes the org (and run) on every row it records', () => {
    const t = new CostTracker(ledger(), {}, { orgId: 'org-a', runId: 'run-1' });
    try {
      t.trackOperation('openai', 'gpt-4o', false, SPEND);
      t.settle(t.reserve('openai', 'gpt-4o'), { inputTokens: 10, outputTokens: 10 });
    } finally {
      t.close();
    }
    const db = new Database(ledger(), { readonly: true });
    try {
      expect(db.prepare('SELECT org_id, run_id FROM cost_tracking').all()).toEqual([
        { org_id: 'org-a', run_id: 'run-1' },
        { org_id: 'org-a', run_id: 'run-1' },
      ]);
    } finally {
      db.close();
    }
  });

  it("a run's stats count only that run; its daily and monthly totals are the org's", () => {
    const run1 = new CostTracker(ledger(), {}, { orgId: 'org-a', runId: 'run-1' });
    const run2 = new CostTracker(ledger(), {}, { orgId: 'org-a', runId: 'run-2' });
    const other = new CostTracker(ledger(), {}, { orgId: 'org-b', runId: 'run-3' });
    try {
      run1.trackOperation('openai', 'gpt-4o', false, SPEND);
      run2.trackOperation('openai', 'gpt-4o', false, { inputTokens: 400_000, outputTokens: 0 });
      run2.trackOperation('openai', 'gpt-4o', true);

      expect(run1.getStats()).toMatchObject({
        totalCost: 2.5,
        operationCount: 1,
        cacheHitCount: 0,
      });
      expect(run2.getStats()).toMatchObject({ totalCost: 1, operationCount: 2, cacheHitCount: 1 });
      expect(run2.getStats().costByModel).toEqual({ 'gpt-4o': 1 });
      expect(run1.getStats().dailyCost).toBeCloseTo(3.5);
      expect(other.getStats()).toMatchObject({ totalCost: 0, operationCount: 0, dailyCost: 0 });
    } finally {
      run1.close();
      run2.close();
      other.close();
    }
  });

  it("cannot settle, release or clear another org's rows", () => {
    const a = new CostTracker(ledger(), {}, { orgId: 'org-a' });
    const b = new CostTracker(ledger(), {}, { orgId: 'org-b' });
    try {
      const held = a.reserve('openai', 'gpt-4o');
      a.trackOperation('openai', 'gpt-4o', false, SPEND);
      expect(() => b.settle(held, { inputTokens: 1, outputTokens: 1 })).toThrow(
        /No open cost reservation/,
      );
      b.release(held);
      b.clear();
      // Org A's spend and its reservation are both still there.
      expect(a.getDailyCost()).toBeCloseTo(2.5 + 0.03);
      a.clear();
      expect(a.getDailyCost()).toBe(0);
    } finally {
      a.close();
      b.close();
    }
  });

  it('keeps a ledger written before #255 (no org or run columns) working', () => {
    const db = new Database(ledger());
    db.exec(`CREATE TABLE cost_tracking (
      id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, provider TEXT NOT NULL,
      model TEXT NOT NULL, operation TEXT NOT NULL, cost REAL NOT NULL, cached INTEGER NOT NULL DEFAULT 0)`);
    db.prepare(
      `INSERT INTO cost_tracking (timestamp, provider, model, operation, cost) VALUES (?, 'openai', 'gpt-4o', 'text', 0.5)`,
    ).run(Date.now());
    db.close();
    const local = new CostTracker(ledger());
    const tenant = new CostTracker(ledger(), {}, { orgId: 'org-a' });
    try {
      // The old rows were local spend, and stay local spend.
      expect(local.getDailyCost()).toBe(0.5);
      expect(tenant.getDailyCost()).toBe(0);
    } finally {
      local.close();
      tenant.close();
    }
  });
});

describe('SmartAIVisionClient scoped to an org', () => {
  const config: IrisConfig = {
    ai: { provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o' },
    watch: { patterns: [], debounceMs: 1000, ignore: [] },
    browser: { headless: true, timeout: 30000 },
  };
  const request = { baseline: Buffer.from('base'), current: Buffer.from('curr') };
  let calls: number;

  beforeEach(() => {
    calls = 0;
    jest
      .spyOn(
        SmartAIVisionClient.prototype as unknown as { resolveModel(p: string): Promise<string> },
        'resolveModel',
      )
      .mockImplementation(async () => 'gpt-4o');
    jest
      .spyOn(ImagePreprocessor.prototype, 'preprocess')
      .mockImplementation(
        async (input) => ({ buffer: input as Buffer, hash: String(input) }) as never,
      );
    jest.spyOn(AIClientFactory, 'create').mockImplementation(
      () =>
        ({
          isAvailable: async () => true,
          analyzeVisualDiff: async () => {
            calls++;
            return {
              classification: 'intentional',
              confidence: 0.9,
              description: '',
              severity: 'minor',
              reasoning: '',
              usage: { inputTokens: 1000, outputTokens: 100 },
            };
          },
        }) as never,
    );
  });

  const client = (orgId?: string) =>
    createSmartClient(config, {
      orgId,
      cacheConfig: { dbPath: path.join(dir(), 'cache.db') },
      costConfig: { dbPath: ledger(), dailyLimit: 100, monthlyLimit: 100 },
    });

  it("never serves one org's cached verdict to another", async () => {
    const a = client('org-a');
    const b = client('org-b');
    try {
      await a.analyzeVisualDiff(request);
      await a.analyzeVisualDiff(request);
      expect(calls).toBe(1); // org A's second call was its own cache hit
      await b.analyzeVisualDiff(request);
      expect(calls).toBe(2); // org B paid for its own answer
    } finally {
      a.close();
      b.close();
    }
  });

  it('the visual classifier passes its org through (the path #268 will use)', async () => {
    const defaultLedger = path.join(resolveDataDir(), 'cache', 'cost-tracking.db');
    fs.rmSync(defaultLedger, { force: true });
    const classifier = new AIVisualClassifier({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4o',
      orgId: 'org-a',
    });
    try {
      await classifier.analyzeChange({
        baselineImage: Buffer.from('b1'),
        currentImage: Buffer.from('c1'),
      });
    } finally {
      classifier.close();
    }
    const db = new Database(defaultLedger, { readonly: true });
    try {
      expect(db.prepare('SELECT DISTINCT org_id FROM cost_tracking').all()).toEqual([
        { org_id: 'org-a' },
      ]);
    } finally {
      db.close();
    }
  });

  it('reports each billed vision call for the usage ledger, but not a cache hit (#263)', async () => {
    const calls: Array<{ operation: string; costUsd: number; estimated: boolean }> = [];
    const smart = createSmartClient(config, {
      orgId: 'org-a',
      cacheConfig: { dbPath: path.join(dir(), 'cache.db') },
      costConfig: { dbPath: ledger(), dailyLimit: 100, monthlyLimit: 100 },
      onUsage: (call) => void calls.push(call),
    });
    try {
      await smart.analyzeVisualDiff(request);
      await smart.analyzeVisualDiff(request); // served from the cache
    } finally {
      smart.close();
    }
    expect(calls).toEqual([
      expect.objectContaining({
        operation: 'vision-analysis',
        provider: 'openai',
        estimated: false,
      }),
    ]);
    expect(calls[0].costUsd).toBeGreaterThan(0);
  });

  it('reports a vision reply IRIS rejected too: the provider billed it (#263)', async () => {
    const { AIResponseRejectedError } = jest.requireActual('../src/ai-client/base');
    jest.spyOn(AIClientFactory, 'create').mockImplementation(
      () =>
        ({
          isAvailable: async () => true,
          analyzeVisualDiff: async () => {
            throw new AIResponseRejectedError('not JSON', { inputTokens: 1000, outputTokens: 100 });
          },
        }) as never,
    );
    const calls: Array<{ costUsd: number }> = [];
    const smart = createSmartClient(config, {
      enableCache: false,
      costConfig: { dbPath: ledger(), dailyLimit: 100, monthlyLimit: 100 },
      onUsage: (call) => void calls.push(call),
    });
    try {
      await expect(smart.analyzeVisualDiff(request)).rejects.toThrow();
    } finally {
      smart.close();
    }
    expect(calls).toHaveLength(1);
    expect(calls[0].costUsd).toBeGreaterThan(0);
  });

  it("charges the org that asked, and reports only this client's run in its stats", async () => {
    const a1 = client('org-a');
    const a2 = client('org-a');
    try {
      await a1.analyzeVisualDiff(request);
      expect(a1.getCostStats()).toMatchObject({ operationCount: 1 });
      expect(a1.getCostStats()!.totalCost).toBeGreaterThan(0);
      // Same org, another run: an empty summary, but the org's daily spend.
      expect(a2.getCostStats()).toMatchObject({ operationCount: 0, totalCost: 0 });
      expect(a2.getCostStats()!.dailyCost).toBe(a1.getCostStats()!.dailyCost);
    } finally {
      a1.close();
      a2.close();
    }
    const db = new Database(ledger(), { readonly: true });
    try {
      expect(db.prepare('SELECT DISTINCT org_id FROM cost_tracking').all()).toEqual([
        { org_id: 'org-a' },
      ]);
    } finally {
      db.close();
    }
  });
});
