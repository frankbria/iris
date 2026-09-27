import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveDataDir, resolveDbPath } from '../src/data-dir';
import { resolveBudget, IrisConfig } from '../src/config';
import { SmartAIVisionClient } from '../src/ai-client/smart-client';
import { recordA11yRun } from '../src/history';
import type { AccessibilityTestResult } from '../src/a11y/a11y-runner';

/**
 * One data directory for history, the cost ledger and the vision cache (#241).
 *
 * The cost ledger and cache used to be cwd-relative, so the daily budget reset
 * in every directory a user ran from, and in the read-only container they
 * resolved under /app. These tests change the working directory to prove the
 * paths no longer depend on it.
 */

const VARS = [
  'IRIS_DATA_DIR',
  'IRIS_DB_PATH',
  'IRIS_DAILY_BUDGET_USD',
  'IRIS_MONTHLY_BUDGET_USD',
] as const;
let saved: Record<string, string | undefined>;
let tmp: string;
const startCwd = process.cwd();

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-data-dir-'));
  for (const k of VARS) delete process.env[k];
  // A home of our own: the ~/.iris fallback and ~/.iris/config.json both hang
  // off it. Spied, not $HOME: Jest's process.env is a copy the native call never reads.
  jest.spyOn(os, 'homedir').mockReturnValue(path.join(tmp, 'home'));
});

afterEach(() => {
  jest.restoreAllMocks();
  process.chdir(startCwd);
  for (const k of VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** An a11y run over zero pages: enough to make history write its test_run row. */
const EMPTY_A11Y_RUN = {
  results: [],
  summary: { pagesTested: 0, totalViolations: 0, passed: true },
} as unknown as AccessibilityTestResult;

const IRIS: IrisConfig = {
  ai: { provider: 'ollama', model: 'llava' },
  watch: { patterns: [], debounceMs: 0, ignore: [] },
  browser: { headless: true, timeout: 1000 },
};

function writeConfigFile(json: unknown) {
  const dir = path.join(os.homedir(), '.iris');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(json));
}

describe('resolveDataDir', () => {
  test('IRIS_DATA_DIR wins over everything', () => {
    process.env.IRIS_DATA_DIR = path.join(tmp, 'data');
    process.env.IRIS_DB_PATH = path.join(tmp, 'elsewhere', 'iris.db');
    expect(resolveDataDir()).toBe(path.join(tmp, 'data'));
  });

  test('then the directory of IRIS_DB_PATH, so a deployment that sets only that keeps working', () => {
    process.env.IRIS_DB_PATH = path.join(tmp, 'vol', 'iris.db');
    expect(resolveDataDir()).toBe(path.join(tmp, 'vol'));
  });

  test('then ~/.iris', () => {
    expect(resolveDataDir()).toBe(path.join(tmp, 'home', '.iris'));
  });

  test('is absolute even when the variable is relative', () => {
    process.env.IRIS_DATA_DIR = 'rel/data';
    expect(path.isAbsolute(resolveDataDir())).toBe(true);
  });
});

describe('resolveDbPath', () => {
  test('IRIS_DB_PATH names the file outright', () => {
    process.env.IRIS_DATA_DIR = path.join(tmp, 'data');
    process.env.IRIS_DB_PATH = path.join(tmp, 'x', 'history.db');
    expect(resolveDbPath()).toBe(path.join(tmp, 'x', 'history.db'));
  });

  test('a relative IRIS_DB_PATH is made absolute, so it cannot follow the cwd', () => {
    process.env.IRIS_DB_PATH = 'rel/history.db';
    expect(resolveDbPath()).toBe(path.resolve('rel/history.db'));
  });

  test('otherwise iris.db inside the data dir', () => {
    process.env.IRIS_DATA_DIR = path.join(tmp, 'data');
    expect(resolveDbPath()).toBe(path.join(tmp, 'data', 'iris.db'));
  });
});

describe('all three stores land in the data dir, whatever the cwd', () => {
  test('history, cost ledger and vision cache', () => {
    const dataDir = path.join(tmp, 'data');
    process.env.IRIS_DATA_DIR = dataDir;

    for (const cwd of ['a', 'b']) {
      fs.mkdirSync(path.join(tmp, cwd));
      process.chdir(path.join(tmp, cwd));
      new SmartAIVisionClient(IRIS).close();
      recordA11yRun(EMPTY_A11Y_RUN, new Date(), new Date());
      // Nothing written relative to where we stood.
      expect(fs.readdirSync(path.join(tmp, cwd))).toEqual([]);
    }

    expect(fs.existsSync(path.join(dataDir, 'iris.db'))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'cache', 'cost-tracking.db'))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'cache', 'vision-cache.db'))).toBe(true);
  });

  test('an explicit dbPath from the caller still wins', () => {
    process.env.IRIS_DATA_DIR = path.join(tmp, 'data');
    const own = path.join(tmp, 'own', 'cost.db');
    new SmartAIVisionClient(IRIS, { enableCache: false, costConfig: { dbPath: own } }).close();
    expect(fs.existsSync(own)).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'data', 'cache', 'cost-tracking.db'))).toBe(false);
  });
});

describe('resolveBudget', () => {
  test('defaults are $10/day and $200/month', () => {
    expect(resolveBudget()).toEqual({ dailyLimit: 10, monthlyLimit: 200 });
  });

  test('the config file sets them', () => {
    writeConfigFile({ budget: { dailyLimit: 3, monthlyLimit: 40 } });
    expect(resolveBudget()).toEqual({ dailyLimit: 3, monthlyLimit: 40 });
  });

  test('an exported variable beats the file, field by field', () => {
    writeConfigFile({ budget: { dailyLimit: 3, monthlyLimit: 40 } });
    process.env.IRIS_DAILY_BUDGET_USD = '1.5';
    expect(resolveBudget()).toEqual({ dailyLimit: 1.5, monthlyLimit: 40 });
  });

  test("an empty variable counts as unset, like compose's ${X:-}", () => {
    process.env.IRIS_DAILY_BUDGET_USD = '';
    expect(resolveBudget().dailyLimit).toBe(10);
  });

  test('a malformed variable does not break a client that tracks no cost', () => {
    process.env.IRIS_DATA_DIR = path.join(tmp, 'data');
    process.env.IRIS_DAILY_BUDGET_USD = 'abc';
    expect(() =>
      new SmartAIVisionClient(IRIS, { enableCostTracking: false }).close(),
    ).not.toThrow();
    expect(() => new SmartAIVisionClient(IRIS).close()).toThrow(/IRIS_DAILY_BUDGET_USD/);
  });

  test('0 is a real limit: free providers only', () => {
    process.env.IRIS_MONTHLY_BUDGET_USD = '0';
    expect(resolveBudget().monthlyLimit).toBe(0);
  });

  test.each(['abc', '-1', 'Infinity', '10usd', '9'.repeat(400)])(
    'refuses %p rather than running without the limit the user meant',
    (value) => {
      process.env.IRIS_DAILY_BUDGET_USD = value;
      expect(() => resolveBudget()).toThrow(/IRIS_DAILY_BUDGET_USD/);
    },
  );

  test('refuses a malformed value in the config file too', () => {
    writeConfigFile({ budget: { monthlyLimit: '200' } });
    expect(() => resolveBudget()).toThrow(/budget\.monthlyLimit/);
  });

  test('the smart client enforces what was resolved', () => {
    process.env.IRIS_DATA_DIR = path.join(tmp, 'data');
    process.env.IRIS_DAILY_BUDGET_USD = '2';
    process.env.IRIS_MONTHLY_BUDGET_USD = '30';
    const client = new SmartAIVisionClient(IRIS);
    try {
      expect(client.getBudgetStatus()).toMatchObject({ dailyLimit: 2, monthlyLimit: 30 });
    } finally {
      client.close();
    }
  });

  test('an explicit costConfig limit from the caller still wins', () => {
    process.env.IRIS_DATA_DIR = path.join(tmp, 'data');
    process.env.IRIS_DAILY_BUDGET_USD = '2';
    const client = new SmartAIVisionClient(IRIS, { costConfig: { dailyLimit: 7 } });
    try {
      expect(client.getBudgetStatus()).toMatchObject({ dailyLimit: 7, monthlyLimit: 200 });
    } finally {
      client.close();
    }
  });
});
