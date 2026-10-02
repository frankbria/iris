import Database from 'better-sqlite3';
import { ensureDatabaseDir } from '../db';
import { DEFAULT_BUDGET_LIMITS } from '../config';
import { hostedLog } from '../log';

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
 * What a ledger row paid for. Text and agent turns are metered too (issue #242):
 * before them only vision calls reached the tracker.
 */
export type CostOperation = 'vision-analysis' | 'text' | 'agent_turn';

/**
 * Cost tracking entry
 */
export interface CostEntry {
  id?: number;
  timestamp: number;
  provider: string;
  model: string;
  operation: CostOperation;
  cost: number;
  cached: boolean;
  inputTokens?: number;
  outputTokens?: number;
  /** Priced at the conservative default rate: no registered or family price (#243). */
  estimated?: boolean;
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
  // The gpt-4o launch snapshot kept its launch price ($5/1M in, $15/1M out)
  // after gpt-4o itself dropped, so the family fallback (#243) must not give it
  // the cheaper gpt-4o rate.
  {
    provider: 'openai',
    model: 'gpt-4o-2024-05-13',
    costPerImage: 0.004,
    costPerInputToken: 5e-6,
    costPerOutputToken: 1.5e-5,
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
  // Claude Haiku 4.5: $1/1M input, $5/1M output. This is what config.ts:176
  // selects on the ANTHROPIC_API_KEY env path, and `resolveModel` prefers the
  // configured model over the per-provider default — so it is the model the
  // out-of-the-box Anthropic user actually requests. Left unpriced it computes
  // a $0 cost and never accrues against the budget, which is the #126 failure
  // mode on the highest-traffic path (the call is still *gated* — unregistered
  // models fall through to `return true` in isBudgetGated — but spend on it
  // could never trip the breaker in the first place).
  {
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    costPerImage: 0.0005,
    costPerInputToken: 1e-6,
    costPerOutputToken: 5e-6,
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
 * Suffixes that name a snapshot or alias of a model rather than a different
 * model: `-20260514`, `-2024-08-06`, `-latest`. Only these inherit the family's
 * rate (#243). A variant such as `gpt-4o-realtime-preview` is priced
 * differently, so it gets the estimate instead of gpt-4o's cheaper rate.
 */
const SNAPSHOT_SUFFIX = /^-(\d{8}|\d{4}-\d{2}-\d{2}|latest)$/;

/**
 * The most one call is assumed to use, for the budget held while it is in
 * flight (issue #244). Every provider call caps its reply at 1000 tokens, and
 * 8000 input tokens covers three size-capped images plus the prompt.
 *
 * ponytail: a fixed ceiling; a call larger than this (an agent turn carrying a
 * very large page) can overshoot the limit by the difference. Callers that
 * know their input is larger pass their own ceiling to `reserve()`.
 */
export const RESERVATION_CEILING: TokenUsage = { inputTokens: 8000, outputTokens: 1000 };

/**
 * A paid call refused before it was made: spend plus the calls already in
 * flight has reached a budget limit.
 */
export class BudgetExceededError extends Error {
  readonly name = 'BudgetExceededError';

  constructor() {
    super('Budget limit exceeded - circuit breaker activated. No further API calls allowed.');
  }
}

/**
 * provider:model pairs already warned about, so a hot loop warns once (issue
 * #126). Per process, not per tracker: text calls open a tracker per call
 * (#242), and a per-instance set would warn on every one of them.
 */
const unpricedWarned = new Set<string>();

/**
 * Default budget configuration
 */
const DEFAULT_BUDGET: Required<BudgetConfig> = {
  ...DEFAULT_BUDGET_LIMITS,
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
  private readonly orgId: string | null;
  private readonly runId: string | null;

  /**
   * @param scope - Whose spend this tracker records and counts (#255). Every row it
   *   writes carries `orgId` and `runId`, and its budget sums only `orgId`'s rows, so
   *   one org's spend never trips another's breaker. Without an org it is local mode:
   *   the rows with no org, exactly what a ledger held before. `runId` narrows
   *   {@link getStats} totals to one run; daily and monthly spend stay org-wide.
   */
  constructor(
    dbPath: string = ':memory:',
    budget: BudgetConfig = {},
    scope: { orgId?: string; runId?: string } = {},
  ) {
    this.orgId = scope.orgId ?? null;
    this.runId = scope.runId ?? null;
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
        output_tokens INTEGER,
        estimated INTEGER NOT NULL DEFAULT 0,
        pending INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_timestamp ON cost_tracking(timestamp);
      CREATE INDEX IF NOT EXISTS idx_provider_model ON cost_tracking(provider, model);
    `);

    // Idempotent upgrade: databases created before token columns existed get
    // them added here. CREATE TABLE IF NOT EXISTS won't alter an existing table,
    // so check the schema and ALTER only the missing columns.
    // In one IMMEDIATE transaction: two processes upgrading the same old ledger
    // (iris connect and a CLI run on one data dir) would otherwise both read the
    // schema before either ALTER lands, and the second ALTER would throw
    // "duplicate column name".
    this.db
      .transaction(() => {
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
        if (!names.has('estimated')) {
          this.db.exec('ALTER TABLE cost_tracking ADD COLUMN estimated INTEGER NOT NULL DEFAULT 0');
        }
        if (!names.has('pending')) {
          this.db.exec('ALTER TABLE cost_tracking ADD COLUMN pending INTEGER NOT NULL DEFAULT 0');
        }
        // #255: rows written before tenants existed have no org, which is local mode's scope.
        if (!names.has('org_id')) {
          this.db.exec('ALTER TABLE cost_tracking ADD COLUMN org_id TEXT');
        }
        if (!names.has('run_id')) {
          this.db.exec('ALTER TABLE cost_tracking ADD COLUMN run_id TEXT');
        }
      })
      .immediate();
    // After the columns exist: the budget sums read by org and time.
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_org_timestamp ON cost_tracking(org_id, timestamp)',
    );
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
    const key = this.resolveKey(provider, model);
    if (key === undefined) {
      return true; // never registered: assume billable
    }
    // Metered pricing: per-call cost is unknown before the call, but it is paid.
    if (this.tokenPricing.has(key)) {
      return true;
    }
    // Registered at exactly 0 is a deliberate "this is free" — Ollama runs
    // locally, and #68 requires it to proceed even with the breaker tripped.
    return (this.pricing.get(key) ?? 0) > 0;
  }

  /**
   * The registered `provider:model` key whose price applies to this model: the
   * exact key, else the registered model of the same provider that this ID
   * extends by one snapshot suffix (issue #243, SNAPSHOT_SUFFIX). That is how
   * dated and rescued IDs are named — `resolveModel` swaps a retired
   * `claude-sonnet-5` pin for `claude-sonnet-5-20260514` — while `gpt-4oz` and
   * `gpt-4o-realtime-preview` are not gpt-4o. Undefined when nothing matches.
   */
  private resolveKey(provider: string, model: string): string | undefined {
    const exact = `${provider}:${model}`;
    if (this.pricing.has(exact)) return exact;
    // At most one key can match: the remainder must be a single snapshot token,
    // so a shorter key would leave two. No "longest" comparison is needed.
    return [...this.pricing.keys()].find(
      (key) => exact.startsWith(key) && SNAPSHOT_SUFFIX.test(exact.slice(key.length)),
    );
  }

  /**
   * Rates charged for a model with no registered or family price (#243): the
   * dearest registered value, per field, including anything added through
   * `setPricing`. The ledger gates a budget breaker, so an unknown model must
   * over-report rather than record $0 and never trip it.
   *
   * ponytail: capped at the dearest *known* rate; a model priced above every
   * registered one (o1-pro class) still under-reports until it gets a row.
   */
  private estimatedRates(): TokenRates & { costPerImage: number } {
    const tokens = [...this.tokenPricing.values()];
    return {
      costPerImage: Math.max(0, ...this.pricing.values()),
      input: Math.max(0, ...tokens.map((r) => r.input)),
      output: Math.max(0, ...tokens.map((r) => r.output)),
    };
  }

  /**
   * Record a completed AI operation (vision analysis by default).
   *
   * Cost is computed from real token usage when both usage and per-token rates
   * are available; otherwise it falls back to the flat per-image price. Cached
   * operations are always free.
   *
   * Never refuses: by the time a call is recorded it has been paid for, and
   * dropping the row is how spend went missing (issue #244). The breaker
   * decision belongs before the call, in {@link reserve}.
   *
   * @param provider - Provider name
   * @param model - Model identifier
   * @param cached - Whether result was cached
   * @param usage - Optional token usage from the provider
   * @param operation - What the call was for; recorded on the ledger row
   * @returns Cost of operation
   */
  trackOperation(
    provider: string,
    model: string,
    cached: boolean = false,
    usage?: TokenUsage,
    operation: CostOperation = 'vision-analysis',
  ): number {
    const { cost, estimated } = this.computeCost(provider, model, cached, usage);
    this.warnIfEstimated(provider, model, estimated);
    this.db
      .prepare(
        `INSERT INTO cost_tracking (timestamp, provider, model, operation, cost, cached, input_tokens, output_tokens, estimated, org_id, run_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Date.now(),
        provider,
        model,
        operation,
        cost,
        cached ? 1 : 0,
        usage?.inputTokens ?? null,
        usage?.outputTokens ?? null,
        estimated ? 1 : 0,
        this.orgId,
        this.runId,
      );
    return cost;
  }

  /**
   * Hold budget for a call about to be made (issue #244).
   *
   * Inserts a pending row at the call's worst-case cost
   * ({@link RESERVATION_CEILING}), so calls already in flight count against
   * the budget: checking, awaiting the provider, then recording let N
   * concurrent calls all pass one check. The check and the insert share an
   * IMMEDIATE transaction, which also serialises them across connections and
   * processes on the same ledger file.
   *
   * A paid call is admitted while spend plus reservations is under the limit,
   * so spend ends within the limit plus one call. Free providers and
   * zero-priced models (#68) are never refused.
   *
   * @param ceiling - The most this call can use; the estimate is priced from it
   * @returns The reservation id, for {@link settle} or {@link release}
   * @throws {BudgetExceededError} when the call is billable and a limit is reached
   */
  reserve(
    provider: string,
    model: string,
    operation: CostOperation = 'vision-analysis',
    ceiling: TokenUsage = RESERVATION_CEILING,
  ): number {
    return this.db
      .transaction(() => {
        if (this.isBudgetGated(provider, model) && this.getBudgetStatus().circuitBreakerTriggered) {
          throw new BudgetExceededError();
        }
        const { cost } = this.computeCost(provider, model, false, ceiling);
        const { lastInsertRowid } = this.db
          .prepare(
            `INSERT INTO cost_tracking (timestamp, provider, model, operation, cost, pending, org_id, run_id)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
          )
          .run(Date.now(), provider, model, operation, cost, this.orgId, this.runId);
        return Number(lastInsertRowid);
      })
      .immediate();
  }

  /**
   * Replace a reservation's estimate with what the call actually cost. Called
   * for every call the provider answered, including answers IRIS rejected.
   *
   * @param usage - Token usage from the reply; flat per-call price when absent
   * @returns Cost of the call
   */
  settle(id: number, usage?: TokenUsage): number {
    const row = this.db
      // Scoped like every read (#255): an id from elsewhere cannot settle another
      // org's reservation.
      .prepare(
        'SELECT provider, model FROM cost_tracking WHERE id = ? AND pending = 1 AND org_id IS ?',
      )
      .get(id, this.orgId) as { provider: string; model: string } | undefined;
    if (!row) throw new Error(`No open cost reservation ${id}`);

    const { cost, estimated } = this.computeCost(row.provider, row.model, false, usage);
    this.warnIfEstimated(row.provider, row.model, estimated);
    this.db
      .prepare(
        `UPDATE cost_tracking
         SET cost = ?, input_tokens = ?, output_tokens = ?, estimated = ?, pending = 0
         WHERE id = ? AND pending = 1 AND org_id IS ?`,
      )
      .run(
        cost,
        usage?.inputTokens ?? null,
        usage?.outputTokens ?? null,
        estimated ? 1 : 0,
        id,
        this.orgId,
      );
    return cost;
  }

  /**
   * Drop a reservation for a call that got no reply, so nothing was billed.
   */
  release(id: number): void {
    this.db
      .prepare('DELETE FROM cost_tracking WHERE id = ? AND pending = 1 AND org_id IS ?')
      .run(id, this.orgId);
  }

  /**
   * Surface the guess rather than silently over-reporting: this operation is
   * recorded at the estimated rate. Once per pair, so a hot loop cannot bury
   * the warning it is trying to raise. A family match is not a guess and does
   * not warn.
   */
  private warnIfEstimated(provider: string, model: string, estimated: boolean): void {
    const key = `${provider}:${model}`;
    if (estimated && !unpricedWarned.has(key)) {
      unpricedWarned.add(key);
      hostedLog(
        'warn',
        'no pricing registered; cost estimated at the dearest known rate',
        { model: key },
        () =>
          console.warn(
            `⚠️  No pricing registered for ${key}; its cost is estimated at the most expensive ` +
              `known rate. Register it with setPricing() for accurate accounting.`,
          ),
      );
    }
  }

  /**
   * Compute the cost of an operation. Token-based when usage and per-token
   * rates are available, flat per-image otherwise. Cached operations and free
   * providers cost nothing; a model with no registered or family price is
   * charged `estimatedRates()` and flagged `estimated` (issue #243).
   */
  /**
   * Whether a call to this model is priced from an estimate (#243): no exact or family
   * price row, so the dearest registered rate was charged. Billing records it (#263).
   */
  priceIsEstimated(provider: string, model: string): boolean {
    return this.computeCost(provider, model, false, { inputTokens: 1, outputTokens: 1 }).estimated;
  }

  private computeCost(
    provider: string,
    model: string,
    cached: boolean,
    usage?: TokenUsage,
  ): { cost: number; estimated: boolean } {
    if (cached) return { cost: 0, estimated: false };

    const key = this.resolveKey(provider, model);
    if (key === undefined && FREE_PROVIDERS.has(provider.toLowerCase())) {
      return { cost: 0, estimated: false };
    }
    const estimated = key === undefined;
    const rates = estimated
      ? this.estimatedRates()
      : { ...this.tokenPricing.get(key), costPerImage: this.pricing.get(key) ?? 0 };
    if (
      usage &&
      rates.input !== undefined &&
      rates.output !== undefined &&
      this.isValidUsage(usage)
    ) {
      return {
        cost: usage.inputTokens * rates.input + usage.outputTokens * rates.output,
        estimated,
      };
    }

    return { cost: rates.costPerImage, estimated };
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
    // `IS`, not `=`: local mode's scope is the rows with no org.
    const stmt = this.db.prepare(
      'SELECT SUM(cost) as total FROM cost_tracking WHERE org_id IS ? AND timestamp >= ? AND timestamp <= ?',
    );
    const result = stmt.get(this.orgId, startTime, endTime) as { total: number | null };
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
    // This tracker's run when it has one, else its whole scope (#255): a run's
    // summary must not report another run's, or another org's, spend.
    const where = this.runId === null ? 'org_id IS ?' : 'org_id IS ? AND run_id = ?';
    const params = this.runId === null ? [this.orgId] : [this.orgId, this.runId];
    const totalStmt = this.db.prepare(
      `SELECT SUM(cost) as total, COUNT(*) as count FROM cost_tracking WHERE ${where}`,
    );
    const totalResult = totalStmt.get(...params) as { total: number | null; count: number };

    const cacheStmt = this.db.prepare(
      `SELECT COUNT(*) as count FROM cost_tracking WHERE ${where} AND cached = 1`,
    );
    const cacheResult = cacheStmt.get(...params) as { count: number };

    const providerStmt = this.db.prepare(
      `SELECT provider, SUM(cost) as total FROM cost_tracking WHERE ${where} GROUP BY provider`,
    );
    const providerResults = providerStmt.all(...params) as Array<{
      provider: string;
      total: number;
    }>;

    const modelStmt = this.db.prepare(
      `SELECT model, SUM(cost) as total FROM cost_tracking WHERE ${where} GROUP BY model`,
    );
    const modelResults = modelStmt.all(...params) as Array<{
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

    // A limit of 0 means "free providers only", so it is spent before anything
    // is: 0/0 is NaN, and NaN >= 1 is false, which let the first paid call
    // through a $0 budget.
    const fraction = (used: number, limit: number) => (limit > 0 ? used / limit : Infinity);
    const dailyPercent = fraction(dailyCost, this.budget.dailyLimit);
    const monthlyPercent = fraction(monthlyCost, this.budget.monthlyLimit);

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
  /** Delete this tracker's org's rows (local mode: the rows with no org). */
  clear(): void {
    this.db.prepare('DELETE FROM cost_tracking WHERE org_id IS ?').run(this.orgId);
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
