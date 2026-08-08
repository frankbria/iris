import Database from 'better-sqlite3';
import { ensureDatabaseDir } from '../db';

/**
 * AI provider pricing configuration
 */
export interface ProviderPricing {
  provider: string;
  model: string;
  /**
   * Cost per image in USD. Used as a fallback when token usage is unavailable
   * (cache hits, Ollama, providers/paths that don't report usage).
   */
  costPerImage: number;
  /**
   * Cost per input (prompt) token in USD. When set together with
   * `costPerOutputToken`, cost is computed from real token usage.
   */
  costPerInputToken?: number;
  /**
   * Cost per output (completion) token in USD.
   */
  costPerOutputToken?: number;
}

/**
 * Per-token pricing pair, in USD per token.
 */
interface TokenRates {
  input: number;
  output: number;
}

/**
 * Token usage for a single operation.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Budget configuration
 */
export interface BudgetConfig {
  /**
   * Daily budget limit in USD
   */
  dailyLimit?: number;

  /**
   * Monthly budget limit in USD
   */
  monthlyLimit?: number;

  /**
   * Warning threshold as percentage of limit (default: 0.8 = 80%)
   */
  warningThreshold?: number;

  /**
   * Critical threshold as percentage of limit (default: 0.95 = 95%)
   */
  criticalThreshold?: number;

  /**
   * Enable circuit breaker at 100% budget (default: true)
   */
  enableCircuitBreaker?: boolean;
}

/**
 * Cost tracking entry
 */
export interface CostEntry {
  id?: number;
  timestamp: number;
  provider: string;
  model: string;
  operation: 'vision-analysis';
  cost: number;
  cached: boolean;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Cost statistics
 */
export interface CostStats {
  totalCost: number;
  dailyCost: number;
  monthlyCost: number;
  operationCount: number;
  cacheHitCount: number;
  cacheHitRate: number;
  costByProvider: Record<string, number>;
  costByModel: Record<string, number>;
}

/**
 * Budget status
 */
export interface BudgetStatus {
  dailyUsed: number;
  dailyLimit: number;
  dailyRemaining: number;
  dailyPercent: number;
  monthlyUsed: number;
  monthlyLimit: number;
  monthlyRemaining: number;
  monthlyPercent: number;
  warningTriggered: boolean;
  criticalTriggered: boolean;
  circuitBreakerTriggered: boolean;
}

/**
 * Default pricing for common providers (as of 2025)
 */
const DEFAULT_PRICING: ProviderPricing[] = [
  // OpenAI GPT-4o: $2.50/1M input tokens, $10/1M output tokens (2025 published
  // rates). costPerImage retained as the fallback when usage is unavailable.
  {
    provider: 'openai',
    model: 'gpt-4o',
    costPerImage: 0.002,
    costPerInputToken: 2.5e-6,
    costPerOutputToken: 1e-5,
  },
  // gpt-4o-mini is what config.ts defaults `ai.model` to, so the out-of-the-box
  // model was the one going unpriced and ungated (issue #126).
  // $0.15/1M input, $0.60/1M output (2025 published rates).
  {
    provider: 'openai',
    model: 'gpt-4o-mini',
    costPerImage: 0.0002,
    costPerInputToken: 1.5e-7,
    costPerOutputToken: 6e-7,
  },
  { provider: 'openai', model: 'gpt-4-vision-preview', costPerImage: 0.003 },

  // Anthropic Claude Sonnet 5: $3/1M input tokens, $15/1M output tokens — the
  // same per-token rates Claude 3.5 Sonnet carried, so issue #183's retirement
  // renamed this row without re-rating it.
  //
  // Deliberately the standard rate, not the $2/$10 introductory rate running to
  // 2026-08-31: this table gates a budget circuit breaker, and the safe error
  // direction is over-reporting (the breaker trips early) rather than under-
  // reporting (real spend outruns the tracked total once the intro rate lapses).
  {
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    costPerImage: 0.0015,
    costPerInputToken: 3e-6,
    costPerOutputToken: 1.5e-5,
  },
  // Claude Opus 5: $5/1M input, $25/1M output. Not a default anywhere — priced
  // so a user who configures it is gated rather than treated as free (#126).
  {
    provider: 'anthropic',
    model: 'claude-opus-5',
    costPerImage: 0.004,
    costPerInputToken: 5e-6,
    costPerOutputToken: 2.5e-5,
  },

  // Ollama (local) - no cost (no token rates needed; fallback is zero)
  { provider: 'ollama', model: 'llava', costPerImage: 0 },
  { provider: 'ollama', model: 'bakllava', costPerImage: 0 },
];

/**
 * Providers with no per-call cost at all, whatever model is used.
 *
 * Ollama runs locally, so `ollama:moondream` is exactly as free as
 * `ollama:llava` — the exemption issue #68 won is about the PROVIDER, not about
 * which of its models we happened to pre-register. Gating per model would
 * re-block every local model missing from DEFAULT_PRICING.
 */
const FREE_PROVIDERS = new Set(['ollama']);

/**
 * Default budget configuration
 */
const DEFAULT_BUDGET: Required<BudgetConfig> = {
  dailyLimit: 10.0, // $10/day
  monthlyLimit: 200.0, // $200/month
  warningThreshold: 0.8, // 80%
  criticalThreshold: 0.95, // 95%
  enableCircuitBreaker: true,
};

/**
 * Cost tracker for AI vision API usage
 *
 * Tracks costs across providers and models with budget management.
 * Provides alerts and circuit breaker functionality.
 */
export class CostTracker {
  private db: Database.Database;
  private budget: Required<BudgetConfig>;
  private pricing: Map<string, number>;
  private tokenPricing: Map<string, TokenRates>;
  /** provider:model pairs already warned about, so a hot loop warns once (issue #126). */
  private unpricedWarned: Set<string> = new Set();

  constructor(dbPath: string = ':memory:', budget: BudgetConfig = {}) {
    ensureDatabaseDir(dbPath);
    this.db = new Database(dbPath);
    this.budget = { ...DEFAULT_BUDGET, ...budget };
    this.pricing = new Map();
    this.tokenPricing = new Map();

    // Load default pricing
    for (const price of DEFAULT_PRICING) {
      this.setPricing(
        price.provider,
        price.model,
        price.costPerImage,
        price.costPerInputToken,
        price.costPerOutputToken,
      );
    }

    this.initializeDatabase();
  }

  /**
   * Initialize database schema
   */
  private initializeDatabase(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cost_tracking (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        operation TEXT NOT NULL,
        cost REAL NOT NULL,
        cached INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER,
        output_tokens INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_timestamp ON cost_tracking(timestamp);
      CREATE INDEX IF NOT EXISTS idx_provider_model ON cost_tracking(provider, model);
    `);

    // Idempotent upgrade: databases created before token columns existed get
    // them added here. CREATE TABLE IF NOT EXISTS won't alter an existing table,
    // so check the schema and ALTER only the missing columns.
    const columns = this.db.prepare('PRAGMA table_info(cost_tracking)').all() as Array<{
      name: string;
    }>;
    const names = new Set(columns.map((c) => c.name));
    if (!names.has('input_tokens')) {
      this.db.exec('ALTER TABLE cost_tracking ADD COLUMN input_tokens INTEGER');
    }
    if (!names.has('output_tokens')) {
      this.db.exec('ALTER TABLE cost_tracking ADD COLUMN output_tokens INTEGER');
    }
  }

  /**
   * Set pricing for a provider/model combination
   *
   * @param provider - Provider name
   * @param model - Model identifier
   * @param costPerImage - Cost per image in USD (fallback when usage is absent)
   * @param costPerInputToken - Optional per-input-token cost in USD
   * @param costPerOutputToken - Optional per-output-token cost in USD
   */
  setPricing(
    provider: string,
    model: string,
    costPerImage: number,
    costPerInputToken?: number,
    costPerOutputToken?: number,
  ): void {
    const key = `${provider}:${model}`;
    this.pricing.set(key, costPerImage);
    if (costPerInputToken !== undefined && costPerOutputToken !== undefined) {
      this.tokenPricing.set(key, { input: costPerInputToken, output: costPerOutputToken });
    } else {
      // Overriding with flat-only pricing must clear any prior token rates,
      // otherwise a stale rate would silently win over the new per-image price.
      this.tokenPricing.delete(key);
    }
  }

  /**
   * Get pricing for a provider/model combination
   *
   * @param provider - Provider name
   * @param model - Model identifier
   * @returns Cost per image in USD, or 0 if not configured
   */
  getPricing(provider: string, model: string): number {
    const key = `${provider}:${model}`;
    return this.pricing.get(key) || 0;
  }

  /**
   * Should this operation be subject to the budget?
   *
   * `getPricing` answers 0 both for "registered as free" and for "never
   * registered", and the breaker used to read the second as the first — so a
   * real paid model that nobody had priced was recorded at $0 and exempted
   * from enforcement (issue #126).
   *
   * The two are different claims and only one is safe to assume. An unknown
   * price is treated as billable: over-gating costs a user one explicit
   * `setPricing` call, while under-gating costs them money.
   */
  isBudgetGated(provider: string, model: string): boolean {
    // Provider-level first. A local provider is free for every model it runs,
    // including ones we never registered — checking the model map first would
    // re-gate exactly the operations #68 exempted.
    if (FREE_PROVIDERS.has(provider.toLowerCase())) {
      return false;
    }
    const key = `${provider}:${model}`;
    // Metered pricing: per-call cost is unknown before the call, but it is paid.
    if (this.tokenPricing.has(key)) {
      return true;
    }
    const flat = this.pricing.get(key);
    // Registered at exactly 0 is a deliberate "this is free" — Ollama runs
    // locally, and #68 requires it to proceed even with the breaker tripped.
    if (flat !== undefined) {
      return flat > 0;
    }
    return true; // never registered: assume billable
  }

  /**
   * Track a vision analysis operation
   *
   * Cost is computed from real token usage when both usage and per-token rates
   * are available; otherwise it falls back to the flat per-image price. Cached
   * operations are always free.
   *
   * @param provider - Provider name
   * @param model - Model identifier
   * @param cached - Whether result was cached
   * @param usage - Optional token usage from the provider
   * @returns Cost of operation
   * @throws Error if circuit breaker is triggered and the operation is paid
   *   (cost > 0); cached and free-provider operations always succeed
   */
  trackOperation(
    provider: string,
    model: string,
    cached: boolean = false,
    usage?: TokenUsage,
  ): number {
    const cost = this.computeCost(provider, model, cached, usage);

    // Circuit breaker blocks billable operations (issue #68): cache hits and
    // free providers (Ollama) cost $0 and must always proceed. Checked before
    // recording, so paid enforcement is not bypassed.
    //
    // Gated on `isBudgetGated`, not on `cost > 0` (issue #126). A paid model
    // that nobody priced computes a cost of 0, so the old test read it as free
    // and waved it through a tripped breaker — exactly the operation the
    // breaker exists to stop.
    const billable = !cached && this.isBudgetGated(provider, model);

    if (billable && this.budget.enableCircuitBreaker) {
      const status = this.getBudgetStatus();
      if (status.circuitBreakerTriggered) {
        throw new Error(
          'Budget limit exceeded - circuit breaker activated. No further API calls allowed.',
        );
      }
    }

    // Surface the accounting gap rather than silently under-reporting: this
    // operation will be billed by the provider and recorded here as $0. Once
    // per pair, so a hot loop cannot bury the warning it is trying to raise.
    // Only when the pair is genuinely unregistered. A model registered with
    // token rates but called without usage also lands at $0, but there the
    // advice to "register it with setPricing()" is simply wrong — it IS
    // registered; the gap is the provider not reporting usage.
    const key = `${provider}:${model}`;
    const registered = this.tokenPricing.has(key) || this.pricing.has(key);
    if (billable && cost === 0 && !registered) {
      if (!this.unpricedWarned.has(key)) {
        this.unpricedWarned.add(key);
        console.warn(
          `⚠️  No pricing registered for ${key}; its cost is recorded as $0 and will not count ` +
            `against the budget. Register it with setPricing() for accurate accounting.`,
        );
      }
    }

    // Record entry (persist token counts when provided)
    const stmt = this.db.prepare(`
      INSERT INTO cost_tracking (timestamp, provider, model, operation, cost, cached, input_tokens, output_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      Date.now(),
      provider,
      model,
      'vision-analysis',
      cost,
      cached ? 1 : 0,
      usage?.inputTokens ?? null,
      usage?.outputTokens ?? null,
    );

    return cost;
  }

  /**
   * Compute the cost of an operation. Token-based when usage and per-token
   * rates are available, flat per-image otherwise. Cached operations are free.
   */
  private computeCost(
    provider: string,
    model: string,
    cached: boolean,
    usage?: TokenUsage,
  ): number {
    if (cached) return 0;

    const tokenRates = this.tokenPricing.get(`${provider}:${model}`);
    if (usage && tokenRates && this.isValidUsage(usage)) {
      return usage.inputTokens * tokenRates.input + usage.outputTokens * tokenRates.output;
    }

    return this.getPricing(provider, model);
  }

  /**
   * Guard the cost-integrity boundary: token counts must be finite and
   * non-negative. A NaN or negative count would corrupt the recorded cost and,
   * because budget status is derived from an irreversible SUM, poison every
   * later circuit-breaker check. All-zero usage is treated as "no usage" — a
   * real, uncached API call always consumes prompt tokens, so a zeroed object
   * would record the call as free (the under-counting issue #67 fixes).
   * Invalid usage falls back to per-image pricing.
   */
  private isValidUsage(usage: TokenUsage): boolean {
    return (
      Number.isFinite(usage.inputTokens) &&
      Number.isFinite(usage.outputTokens) &&
      usage.inputTokens >= 0 &&
      usage.outputTokens >= 0 &&
      usage.inputTokens + usage.outputTokens > 0
    );
  }

  /**
   * Get total cost for a time period
   *
   * @param startTime - Start timestamp in milliseconds
   * @param endTime - End timestamp in milliseconds
   * @returns Total cost in USD
   */
  getCostForPeriod(startTime: number, endTime: number): number {
    // Both bounds inclusive. The budget getters no longer pass a clock-derived
    // upper bound at all (issue #132) — this stays bounded for genuine range
    // and reporting queries, where excluding what falls outside the range is
    // the entire point.
    const stmt = this.db.prepare(
      'SELECT SUM(cost) as total FROM cost_tracking WHERE timestamp >= ? AND timestamp <= ?',
    );
    const result = stmt.get(startTime, endTime) as { total: number | null };
    return result.total || 0;
  }

  /**
   * Get daily cost (current day)
   *
   * Deliberately unbounded above. Bounding at `Date.now()` looks natural, but a
   * backward clock movement — NTP correction, VM or WSL suspend-resume, host
   * time sync — makes every row written before the jump future-dated, drops it
   * from the sum, and silently disarms the circuit breaker while real spend
   * continues. Observed in practice, not theoretical (issue #132).
   *
   * Spend already recorded is spend, whatever its timestamp says. Overcounting
   * slightly (a row from just after a backward jump across midnight) fails
   * safe; undercounting allows unbounded overspend. `getCostForPeriod` remains
   * bounded for genuine range and reporting queries.
   *
   * @returns Total cost today in USD
   */
  getDailyCost(): number {
    return this.getCostForPeriod(this.getStartOfDay(Date.now()), Number.MAX_SAFE_INTEGER);
  }

  /**
   * Get monthly cost (current month)
   *
   * Unbounded above for the same reason as {@link getDailyCost} (issue #132).
   *
   * @returns Total cost this month in USD
   */
  getMonthlyCost(): number {
    return this.getCostForPeriod(this.getStartOfMonth(Date.now()), Number.MAX_SAFE_INTEGER);
  }

  /**
   * Get comprehensive statistics
   *
   * @returns Cost statistics
   */
  getStats(): CostStats {
    const totalStmt = this.db.prepare(
      'SELECT SUM(cost) as total, COUNT(*) as count FROM cost_tracking',
    );
    const totalResult = totalStmt.get() as { total: number | null; count: number };

    const cacheStmt = this.db.prepare(
      'SELECT COUNT(*) as count FROM cost_tracking WHERE cached = 1',
    );
    const cacheResult = cacheStmt.get() as { count: number };

    const providerStmt = this.db.prepare(
      'SELECT provider, SUM(cost) as total FROM cost_tracking GROUP BY provider',
    );
    const providerResults = providerStmt.all() as Array<{
      provider: string;
      total: number;
    }>;

    const modelStmt = this.db.prepare(
      'SELECT model, SUM(cost) as total FROM cost_tracking GROUP BY model',
    );
    const modelResults = modelStmt.all() as Array<{
      model: string;
      total: number;
    }>;

    const costByProvider: Record<string, number> = {};
    for (const row of providerResults) {
      costByProvider[row.provider] = row.total;
    }

    const costByModel: Record<string, number> = {};
    for (const row of modelResults) {
      costByModel[row.model] = row.total;
    }

    const operationCount = totalResult.count;
    const cacheHitCount = cacheResult.count;
    const cacheHitRate = operationCount > 0 ? cacheHitCount / operationCount : 0;

    return {
      totalCost: totalResult.total || 0,
      dailyCost: this.getDailyCost(),
      monthlyCost: this.getMonthlyCost(),
      operationCount,
      cacheHitCount,
      cacheHitRate,
      costByProvider,
      costByModel,
    };
  }

  /**
   * Get budget status with alert levels
   *
   * @returns Budget status
   */
  getBudgetStatus(): BudgetStatus {
    const dailyCost = this.getDailyCost();
    const monthlyCost = this.getMonthlyCost();

    const dailyPercent = dailyCost / this.budget.dailyLimit;
    const monthlyPercent = monthlyCost / this.budget.monthlyLimit;

    const warningTriggered =
      dailyPercent >= this.budget.warningThreshold ||
      monthlyPercent >= this.budget.warningThreshold;

    const criticalTriggered =
      dailyPercent >= this.budget.criticalThreshold ||
      monthlyPercent >= this.budget.criticalThreshold;

    const circuitBreakerTriggered =
      this.budget.enableCircuitBreaker && (dailyPercent >= 1.0 || monthlyPercent >= 1.0);

    return {
      dailyUsed: dailyCost,
      dailyLimit: this.budget.dailyLimit,
      dailyRemaining: Math.max(0, this.budget.dailyLimit - dailyCost),
      dailyPercent,
      monthlyUsed: monthlyCost,
      monthlyLimit: this.budget.monthlyLimit,
      monthlyRemaining: Math.max(0, this.budget.monthlyLimit - monthlyCost),
      monthlyPercent,
      warningTriggered,
      criticalTriggered,
      circuitBreakerTriggered,
    };
  }

  /**
   * Update budget configuration
   *
   * @param budget - New budget configuration
   */
  updateBudget(budget: BudgetConfig): void {
    this.budget = { ...this.budget, ...budget };
  }

  /**
   * Clear all cost tracking data
   */
  clear(): void {
    this.db.prepare('DELETE FROM cost_tracking').run();
  }

  /**
   * Get start of day timestamp
   */
  private getStartOfDay(timestamp: number): number {
    const date = new Date(timestamp);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }

  /**
   * Get start of month timestamp
   */
  private getStartOfMonth(timestamp: number): number {
    const date = new Date(timestamp);
    date.setDate(1);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }
}

/**
 * Create a cost tracker instance
 */
export function createCostTracker(dbPath?: string, budget?: BudgetConfig): CostTracker {
  return new CostTracker(dbPath, budget);
}
