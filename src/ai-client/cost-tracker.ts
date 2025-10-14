import Database from 'better-sqlite3';

/**
 * AI provider pricing configuration
 */
export interface ProviderPricing {
  provider: string;
  model: string;
  /**
   * Cost per image in USD
   */
  costPerImage: number;
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
  // OpenAI GPT-4V pricing
  { provider: 'openai', model: 'gpt-4o', costPerImage: 0.002 }, // $0.002 per image
  { provider: 'openai', model: 'gpt-4-vision-preview', costPerImage: 0.003 },

  // Anthropic Claude 3.5 Sonnet pricing
  {
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-20241022',
    costPerImage: 0.0015,
  }, // $0.0015 per image
  { provider: 'anthropic', model: 'claude-3-opus', costPerImage: 0.004 },

  // Ollama (local) - no cost
  { provider: 'ollama', model: 'llava', costPerImage: 0 },
  { provider: 'ollama', model: 'bakllava', costPerImage: 0 },
];

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

  constructor(dbPath: string = ':memory:', budget: BudgetConfig = {}) {
    this.db = new Database(dbPath);
    this.budget = { ...DEFAULT_BUDGET, ...budget };
    this.pricing = new Map();

    // Load default pricing
    for (const price of DEFAULT_PRICING) {
      this.setPricing(price.provider, price.model, price.costPerImage);
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
        cached INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_timestamp ON cost_tracking(timestamp);
      CREATE INDEX IF NOT EXISTS idx_provider_model ON cost_tracking(provider, model);
    `);
  }

  /**
   * Set pricing for a provider/model combination
   *
   * @param provider - Provider name
   * @param model - Model identifier
   * @param costPerImage - Cost per image in USD
   */
  setPricing(provider: string, model: string, costPerImage: number): void {
    const key = `${provider}:${model}`;
    this.pricing.set(key, costPerImage);
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
   * Track a vision analysis operation
   *
   * @param provider - Provider name
   * @param model - Model identifier
   * @param cached - Whether result was cached
   * @returns Cost of operation
   * @throws Error if circuit breaker is triggered
   */
  trackOperation(
    provider: string,
    model: string,
    cached: boolean = false
  ): number {
    // Check circuit breaker
    const status = this.getBudgetStatus();
    if (
      this.budget.enableCircuitBreaker &&
      status.circuitBreakerTriggered
    ) {
      throw new Error(
        'Budget limit exceeded - circuit breaker activated. No further API calls allowed.'
      );
    }

    // Calculate cost (no cost for cached results)
    const cost = cached ? 0 : this.getPricing(provider, model);

    // Record entry
    const stmt = this.db.prepare(`
      INSERT INTO cost_tracking (timestamp, provider, model, operation, cost, cached)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(Date.now(), provider, model, 'vision-analysis', cost, cached ? 1 : 0);

    return cost;
  }

  /**
   * Get total cost for a time period
   *
   * @param startTime - Start timestamp in milliseconds
   * @param endTime - End timestamp in milliseconds
   * @returns Total cost in USD
   */
  getCostForPeriod(startTime: number, endTime: number): number {
    const stmt = this.db.prepare(
      'SELECT SUM(cost) as total FROM cost_tracking WHERE timestamp >= ? AND timestamp < ?'
    );
    const result = stmt.get(startTime, endTime) as { total: number | null };
    return result.total || 0;
  }

  /**
   * Get daily cost (current day)
   *
   * @returns Total cost today in USD
   */
  getDailyCost(): number {
    const startOfDay = this.getStartOfDay(Date.now());
    return this.getCostForPeriod(startOfDay, Date.now());
  }

  /**
   * Get monthly cost (current month)
   *
   * @returns Total cost this month in USD
   */
  getMonthlyCost(): number {
    const startOfMonth = this.getStartOfMonth(Date.now());
    return this.getCostForPeriod(startOfMonth, Date.now());
  }

  /**
   * Get comprehensive statistics
   *
   * @returns Cost statistics
   */
  getStats(): CostStats {
    const totalStmt = this.db.prepare(
      'SELECT SUM(cost) as total, COUNT(*) as count FROM cost_tracking'
    );
    const totalResult = totalStmt.get() as { total: number | null; count: number };

    const cacheStmt = this.db.prepare(
      'SELECT COUNT(*) as count FROM cost_tracking WHERE cached = 1'
    );
    const cacheResult = cacheStmt.get() as { count: number };

    const providerStmt = this.db.prepare(
      'SELECT provider, SUM(cost) as total FROM cost_tracking GROUP BY provider'
    );
    const providerResults = providerStmt.all() as Array<{
      provider: string;
      total: number;
    }>;

    const modelStmt = this.db.prepare(
      'SELECT model, SUM(cost) as total FROM cost_tracking GROUP BY model'
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
    const cacheHitRate =
      operationCount > 0 ? cacheHitCount / operationCount : 0;

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
      this.budget.enableCircuitBreaker &&
      (dailyPercent >= 1.0 || monthlyPercent >= 1.0);

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
export function createCostTracker(
  dbPath?: string,
  budget?: BudgetConfig
): CostTracker {
  return new CostTracker(dbPath, budget);
}
