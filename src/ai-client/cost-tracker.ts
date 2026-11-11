import Database from 'better-sqlite3';
import { ensureDatabaseDir } from '../db';
import { DEFAULT_BUDGET_LIMITS, resolveBudget } from '../config';
import { hostedLog } from '../log';
import { dropLegacyIndexes } from './cache';
import { fineTunedBase } from './models';

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
  /** The rates of a call whose input is over a vendor threshold (#523). */
  longContext?: LongContextPricing;
}

/**
 * A vendor's dearer tier for long prompts (#523): a call with more than `aboveInputTokens`
 * input tokens pays these rates for all of its tokens, not only those past the threshold.
 */
export interface LongContextPricing {
  aboveInputTokens: number;
  costPerInputToken: number;
  costPerOutputToken: number;
}

/**
 * Per-token pricing pair, in USD per token.
 */
interface TokenRates {
  input: number;
  output: number;
  longContext?: { aboveInputTokens: number; input: number; output: number };
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

/** OpenAI charges this tier for the whole request above 272K input tokens (#523). */
const OPENAI_LONG_CONTEXT_TOKENS = 272_000;

/**
 * A token-priced row from the vendor's "per 1M tokens" figures. `costPerImage`, the flat
 * charge for a call recorded without usage, defaults to 800 input tokens' worth.
 */
function tokenPriced(
  provider: 'openai' | 'anthropic',
  model: string,
  inputUsdPerMillion: number,
  outputUsdPerMillion: number,
  options: {
    costPerImage?: number;
    longContext?: {
      aboveInputTokens: number;
      inputUsdPerMillion: number;
      outputUsdPerMillion: number;
    };
  } = {},
): ProviderPricing {
  // Divided, not multiplied by 1e-6: the quotient is the double nearest the decimal rate.
  const costPerInputToken = inputUsdPerMillion / 1_000_000;
  const { longContext } = options;
  return {
    provider,
    model,
    costPerImage: options.costPerImage ?? 800 * costPerInputToken,
    costPerInputToken,
    costPerOutputToken: outputUsdPerMillion / 1_000_000,
    ...(longContext && {
      longContext: {
        aboveInputTokens: longContext.aboveInputTokens,
        costPerInputToken: longContext.inputUsdPerMillion / 1_000_000,
        costPerOutputToken: longContext.outputUsdPerMillion / 1_000_000,
      },
    }),
  };
}

/** An OpenAI row whose long-context tier is the page's "long context" columns. */
function openAITiered(
  model: string,
  short: [inputUsdPerMillion: number, outputUsdPerMillion: number],
  long: [inputUsdPerMillion: number, outputUsdPerMillion: number],
): ProviderPricing {
  return tokenPriced('openai', model, short[0], short[1], {
    longContext: {
      aboveInputTokens: OPENAI_LONG_CONTEXT_TOKENS,
      inputUsdPerMillion: long[0],
      outputUsdPerMillion: long[1],
    },
  });
}

/**
 * Default pricing, USD per 1M tokens at each vendor's standard rate: not batch, flex or
 * fast, never a promotion, and cached input charged as plain input. The table gates a
 * budget breaker, so where there is a choice it over-reports.
 *
 * Checked 2026-11-11 (#523) against https://developers.openai.com/api/docs/pricing,
 * https://developers.openai.com/api/docs/deprecations and
 * https://platform.claude.com/docs/en/about-claude/pricing. Re-check all three when a
 * vendor ships or retires a model; prices are never written from memory.
 *
 * A deprecated model keeps its row until the vendor stops serving it: spend on it is
 * still billed, and without a row it is charged the dearest rate here. Such rows carry
 * their shutdown date; delete them after it.
 */
export const DEFAULT_PRICING: readonly ProviderPricing[] = [
  // OpenAI, current. Short-context rates, then the rates of a request over 272K input tokens.
  openAITiered('gpt-6-astra', [10, 50], [20, 75]),
  openAITiered('gpt-6.1-sol', [2, 10], [4, 15]),
  // The OpenAI vision default.
  openAITiered('gpt-6.1-terra', [1, 5], [2, 7.5]),
  openAITiered('gpt-6-sol', [2, 10], [4, 15]),
  // The OpenAI text default: what config.ts gives `ai.model` out of the box (#126).
  openAITiered('gpt-6-luna', [0.1, 0.5], [0.2, 0.75]),
  // $4/$20 until 2026-11-30 is a promotion ("a 20% reduction in input pricing and a 33%
  // reduction in output pricing"); this is the price it returns to.
  openAITiered('gpt-5.6-sol', [5, 30], [10, 45]),
  openAITiered('gpt-5.6-terra', [2, 12], [4, 18]),
  openAITiered('gpt-5.6-luna', [0.2, 1.2], [0.4, 1.8]),
  openAITiered('gpt-5.5', [5, 30], [10, 45]),
  openAITiered('gpt-5.4', [2.5, 15], [5, 22.5]),
  // One rate each on the pricing page: gpt-5.4-mini takes at most 272,000 input tokens, and
  // gpt-5.2 (400K window) is listed without long-context columns.
  tokenPriced('openai', 'gpt-5.4-mini', 0.75, 4.5),
  tokenPriced('openai', 'gpt-5.2', 1.75, 14),
  // The -pro variants ($21 to $30 in, $168 to $180 out) have no row on purpose: they are
  // served by the Responses API only, which IRIS does not call, and a row that dear would
  // become every unpriced model's estimate (#388).

  // OpenAI, deprecated but served until the date given.
  // Shutdown 2027-04-01:
  tokenPriced('openai', 'gpt-5.1', 1.25, 10),
  tokenPriced('openai', 'gpt-5.4-nano', 0.2, 1.25),
  // Shutdown 2027-01-14 (their last snapshots; the aliases go with them):
  tokenPriced('openai', 'gpt-4o', 2.5, 10),
  tokenPriced('openai', 'gpt-4o-mini', 0.15, 0.6, { costPerImage: 0.0002 }),
  tokenPriced('openai', 'gpt-4.1', 2, 8),
  tokenPriced('openai', 'gpt-4.1-mini', 0.4, 1.6),
  // Fine-tunes of those four, `ft:<base>:<org>:<suffix>:<id>`, priced by the page's
  // "Fine-tuning" table (#664). They are served until their base is shut down, on the same
  // date. A fine-tune of any other base has no rate there and stays an estimate.
  tokenPriced('openai', 'ft:gpt-4o-2024-08-06', 3.75, 15),
  tokenPriced('openai', 'ft:gpt-4o-mini-2024-07-18', 0.3, 1.2),
  tokenPriced('openai', 'ft:gpt-4.1-2025-04-14', 3, 12),
  tokenPriced('openai', 'ft:gpt-4.1-mini-2025-04-14', 0.8, 3.2),
  // Shutdown 2026-12-11:
  tokenPriced('openai', 'gpt-5', 1.25, 10),
  tokenPriced('openai', 'gpt-5-mini', 0.25, 2),
  tokenPriced('openai', 'gpt-5-nano', 0.05, 0.4),
  tokenPriced('openai', 'o3', 2, 8),

  // Anthropic, current.
  tokenPriced('anthropic', 'claude-fable-5-2', 8, 40),
  tokenPriced('anthropic', 'claude-fable-5-1', 10, 50),
  tokenPriced('anthropic', 'claude-fable-5', 10, 50),
  tokenPriced('anthropic', 'claude-opus-5-5', 4, 20),
  // Not a default anywhere: priced so a user who configures it is gated, not free (#126).
  tokenPriced('anthropic', 'claude-opus-5', 5, 25),
  tokenPriced('anthropic', 'claude-opus-4-8', 5, 25),
  tokenPriced('anthropic', 'claude-opus-4-7', 5, 25),
  tokenPriced('anthropic', 'claude-opus-4-6', 5, 25),
  tokenPriced('anthropic', 'claude-opus-4-5', 5, 25),
  tokenPriced('anthropic', 'claude-sonnet-5-5', 2, 10),
  // The Anthropic vision default. $2/$10 began as an introductory price to 2026-08-31,
  // which is why this row used to say $3/$15; Anthropic has since made it the standard
  // price ("the previously scheduled increase ... will not occur"). The flat fallback
  // keeps its old, higher value.
  tokenPriced('anthropic', 'claude-sonnet-5', 2, 10, { costPerImage: 0.0015 }),
  tokenPriced('anthropic', 'claude-sonnet-4-6', 3, 15),
  // Priced by prompt length: over 100,000 prompt tokens the whole request pays 5x.
  tokenPriced('anthropic', 'claude-haiku-5-5', 0.1, 0.5, {
    longContext: { aboveInputTokens: 100_000, inputUsdPerMillion: 0.5, outputUsdPerMillion: 2.5 },
  }),
  // The Anthropic text default: what the ANTHROPIC_API_KEY env path selects, so the model
  // an out-of-the-box Anthropic user actually requests (#126).
  tokenPriced('anthropic', 'claude-haiku-4-5', 1, 5, { costPerImage: 0.0005 }),
  // Claude Mythos has no rows: limited availability, and priced like Fable, which is the
  // dearest rate here and so what an unpriced Mythos call is charged anyway.

  // Anthropic, deprecated: retired 2026-11-30.
  tokenPriced('anthropic', 'claude-sonnet-4-5', 3, 15),

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
 * know their input is larger pass their own ceiling to `reserve()`. Vision keeps the
 * fixed one (#390): the preprocessor caps each image at 2048x2048 and a request carries at
 * most three, which this covers; scale it with the request if either limit grows.
 */
export const RESERVATION_CEILING: TokenUsage = { inputTokens: 8000, outputTokens: 1000 };

/**
 * A pending reservation older than this was left by a process that died mid-call (#390):
 * a call takes at most ~90 s at the default timeout and retries, and an hour leaves room for
 * long configured timeouts. Swept when a tracker opens the ledger.
 */
const STALE_RESERVATION_MS = 60 * 60 * 1000;

/**
 * The most one managed AI call can cost (#482): the reservation ceiling (#244) plus one input
 * token per request character, on whichever of the provider's rows makes that call dearest
 * (a long request may cross a row's long-context threshold, #523). Not the default
 * model's: a retired default is replaced by a successor at call time (#184), which may cost
 * more (codex review). Over-reserving only trims concurrency at the edge of the credit.
 */
export function managedCallEstimateUsd(provider: 'openai' | 'anthropic', inputChars = 0): number {
  const usage: TokenUsage = {
    inputTokens: RESERVATION_CEILING.inputTokens + Math.max(0, inputChars),
    outputTokens: RESERVATION_CEILING.outputTokens,
  };
  return Math.max(
    ...DEFAULT_PRICING.filter((p) => p.provider === provider).map(
      (p) => tokenCost(tokenRates(p) ?? {}, usage) ?? 0,
    ),
  );
}

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
/** Token-priced pairs already warned about being recorded without usage (#388). */
const noUsageWarned = new Set<string>();

/** The token-priced cost of `usage`, or undefined when `rates` has no token prices. */
function tokenCost(rates: Partial<TokenRates>, usage: TokenUsage): number | undefined {
  if (rates.input === undefined || rates.output === undefined) return undefined;
  const long = rates.longContext;
  const tier =
    long && usage.inputTokens > long.aboveInputTokens
      ? long
      : { input: rates.input, output: rates.output };
  return usage.inputTokens * tier.input + usage.outputTokens * tier.output;
}

/** A row's token rates, or undefined for a flat-only row. */
function tokenRates(
  price: Pick<ProviderPricing, 'costPerInputToken' | 'costPerOutputToken' | 'longContext'>,
): TokenRates | undefined {
  if (price.costPerInputToken === undefined || price.costPerOutputToken === undefined) {
    return undefined;
  }
  const long = price.longContext;
  return {
    input: price.costPerInputToken,
    output: price.costPerOutputToken,
    ...(long && {
      longContext: {
        aboveInputTokens: long.aboveInputTokens,
        input: long.costPerInputToken,
        output: long.costPerOutputToken,
      },
    }),
  };
}

/**
 * A token-priced model charged its flat rate because the call came without valid usage
 * (#388): the recorded cost is a guess, so say so once per pair.
 */
function warnFlatFallback(key: string): void {
  if (noUsageWarned.has(key)) return;
  noUsageWarned.add(key);
  hostedLog(
    'warn',
    'call recorded without token usage; charged the flat rate',
    { model: key },
    () =>
      console.warn(`⚠️  ${key} was recorded without token usage; charged its flat per-call rate.`),
  );
}

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
 * USD as integer micro-dollars (#318): money is summed exactly in the ledger, not as REAL.
 * Rounded up, through nano-dollars so float noise (`2.5e-5 * 1e6 = 25.000000000000004`)
 * does not add a micro: a paid call never records $0, and the budget errs high (#243).
 */
export function toMicros(usd: number): number {
  if (!(usd > 0)) return 0;
  return Math.ceil(Math.round(usd * 1e9) / 1000);
}

const fromMicros = (micros: number | null): number => (micros ?? 0) / 1e6;

/**
 * A row's micros when only `cost` is set: rows an older release wrote, and the backfill.
 * The same rule as `toMicros()` (codex review): nano-dollars, then rounded up by integer
 * division, so a legacy row is never counted lower than this release would count it.
 */
const LEGACY_MICROS = '((CAST(ROUND(cost * 1000000000) AS INTEGER) + 999) / 1000)';
/** What every sum adds: the exact column, else the row's `cost` converted. */
const MICROS = `COALESCE(cost_micros, ${LEGACY_MICROS})`;

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
        price.longContext,
      );
    }

    this.initializeDatabase();
  }

  /**
   * Initialize database schema
   */
  private initializeDatabase(): void {
    // Index names are prefixed: they are global to a SQLite file, and the vision cache
    // may share this one (#299).
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
        pending INTEGER NOT NULL DEFAULT 0,
        cost_micros INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_cost_timestamp ON cost_tracking(timestamp);
      CREATE INDEX IF NOT EXISTS idx_cost_provider_model ON cost_tracking(provider, model);
    `);
    dropLegacyIndexes(this.db, 'cost_tracking');

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
        // #318: money in integer micro-dollars, so sums are exact. `cost` stays, written
        // as before, for a release that reads this file and does not know the column.
        if (!names.has('cost_micros')) {
          this.db.exec('ALTER TABLE cost_tracking ADD COLUMN cost_micros INTEGER');
          // Settled rows only (codex review): an older process settles its own pending
          // reservations by updating `cost`, which a fixed `cost_micros` would ignore. Left
          // null, a pending row is summed from `cost`, before and after it settles.
          this.db.exec(`UPDATE cost_tracking SET cost_micros = ${LEGACY_MICROS} WHERE pending = 0`);
        }
      })
      .immediate();
    // After the columns exist: the budget sums read by org and time.
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_org_timestamp ON cost_tracking(org_id, timestamp)',
    );
    // Every org's: a crashed process's reservation is nobody's spend (#390).
    this.db
      .prepare('DELETE FROM cost_tracking WHERE pending = 1 AND timestamp < ?')
      .run(Date.now() - STALE_RESERVATION_MS);
  }

  /**
   * Set pricing for a provider/model combination
   *
   * @param provider - Provider name
   * @param model - Model identifier
   * @param costPerImage - Cost per image in USD (fallback when usage is absent)
   * @param costPerInputToken - Optional per-input-token cost in USD
   * @param costPerOutputToken - Optional per-output-token cost in USD
   * @param longContext - Optional rates for a call over the vendor's input threshold (#523)
   */
  setPricing(
    provider: string,
    model: string,
    costPerImage: number,
    costPerInputToken?: number,
    costPerOutputToken?: number,
    longContext?: LongContextPricing,
  ): void {
    const key = `${provider}:${model}`;
    this.pricing.set(key, costPerImage);
    const rates = tokenRates({ costPerInputToken, costPerOutputToken, longContext });
    if (rates) {
      this.tokenPricing.set(key, rates);
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
   * @returns Cost per image in USD, resolved like the ledger charges it (a dated ID gets
   *   its family's, #388), or 0 if not configured
   */
  getPricing(provider: string, model: string): number {
    const key = this.resolveKey(provider, model);
    return key === undefined ? 0 : (this.pricing.get(key) ?? 0);
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
   * `gpt-4o-realtime-preview` are not gpt-4o. A fine-tuned OpenAI id is looked up as
   * `ft:<base model>` (#664). Undefined when nothing matches.
   */
  private resolveKey(provider: string, model: string): string | undefined {
    const whole = `${provider}:${model}`;
    if (this.pricing.has(whole)) return whole;
    // A fine-tune is billed by its base's fine-tuning rate, whoever trained it (#664).
    const base = fineTunedBase(model);
    const exact = base === undefined ? whole : `${provider}:ft:${base}`;
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
   * registered one (o1-pro class) still under-reports until it gets a row. Kept on
   * purpose (#388): a floor above the table would trip a default budget in a few calls.
   * Short-context rates only, for the same reason: an unpriced model's long prompt is
   * not charged a long-context tier (#523).
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
        `INSERT INTO cost_tracking (timestamp, provider, model, operation, cost, cost_micros, cached, input_tokens, output_tokens, estimated, org_id, run_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Date.now(),
        provider,
        model,
        operation,
        cost,
        toMicros(cost),
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
            `INSERT INTO cost_tracking (timestamp, provider, model, operation, cost, cost_micros, pending, org_id, run_id)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          )
          .run(
            Date.now(),
            provider,
            model,
            operation,
            cost,
            toMicros(cost),
            this.orgId,
            this.runId,
          );
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
         SET cost = ?, cost_micros = ?, input_tokens = ?, output_tokens = ?, estimated = ?, pending = 0
         WHERE id = ? AND pending = 1 AND org_id IS ?`,
      )
      .run(
        cost,
        toMicros(cost),
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
    const priced = this.ratesFor(provider, model);
    if (priced === null) return { cost: 0, estimated: false };
    const { rates, estimated } = priced;
    const tokens = usage && this.isValidUsage(usage) ? tokenCost(rates, usage) : undefined;
    if (tokens !== undefined) return { cost: tokens, estimated };
    // A registered token price charged flat: the call came without usage (#388).
    if (!estimated && rates.input !== undefined) warnFlatFallback(`${provider}:${model}`);
    return { cost: rates.costPerImage, estimated };
  }

  /**
   * The rates a model is charged: its registered or family row, else `estimatedRates()`
   * (`estimated`); `null` for a model on a free provider with no row.
   */
  private ratesFor(
    provider: string,
    model: string,
  ): { rates: Partial<TokenRates> & { costPerImage: number }; estimated: boolean } | null {
    const key = this.resolveKey(provider, model);
    if (key !== undefined) {
      return {
        rates: { ...this.tokenPricing.get(key), costPerImage: this.pricing.get(key) ?? 0 },
        estimated: false,
      };
    }
    return FREE_PROVIDERS.has(provider.toLowerCase())
      ? null
      : { rates: this.estimatedRates(), estimated: true };
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
      `SELECT SUM(${MICROS}) as total FROM cost_tracking WHERE org_id IS ? AND timestamp >= ? AND timestamp <= ?`,
    );
    const result = stmt.get(this.orgId, startTime, endTime) as { total: number | null };
    return fromMicros(result.total);
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
    // Settled rows only (#390): a call in flight is not spend yet. The budget queries
    // (getDailyCost, getMonthlyCost) still count reservations.
    const where =
      this.runId === null
        ? 'org_id IS ? AND pending = 0'
        : 'org_id IS ? AND run_id = ? AND pending = 0';
    const params = this.runId === null ? [this.orgId] : [this.orgId, this.runId];
    const totalStmt = this.db.prepare(
      `SELECT SUM(${MICROS}) as total, COUNT(*) as count FROM cost_tracking WHERE ${where}`,
    );
    const totalResult = totalStmt.get(...params) as { total: number | null; count: number };

    const cacheStmt = this.db.prepare(
      `SELECT COUNT(*) as count FROM cost_tracking WHERE ${where} AND cached = 1`,
    );
    const cacheResult = cacheStmt.get(...params) as { count: number };

    const providerStmt = this.db.prepare(
      `SELECT provider, SUM(${MICROS}) as total FROM cost_tracking WHERE ${where} GROUP BY provider`,
    );
    const providerResults = providerStmt.all(...params) as Array<{
      provider: string;
      total: number;
    }>;

    const modelStmt = this.db.prepare(
      `SELECT model, SUM(${MICROS}) as total FROM cost_tracking WHERE ${where} GROUP BY model`,
    );
    const modelResults = modelStmt.all(...params) as Array<{
      model: string;
      total: number;
    }>;

    const costByProvider: Record<string, number> = {};
    for (const row of providerResults) {
      costByProvider[row.provider] = fromMicros(row.total);
    }

    const costByModel: Record<string, number> = {};
    for (const row of modelResults) {
      costByModel[row.model] = fromMicros(row.total);
    }

    const operationCount = totalResult.count;
    const cacheHitCount = cacheResult.count;
    const cacheHitRate = operationCount > 0 ? cacheHitCount / operationCount : 0;

    return {
      totalCost: fromMicros(totalResult.total),
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
 * Create a cost tracker instance. Limits not given come from `resolveBudget()` (env, then
 * the config file, then the defaults), as the smart client's do (#365): this used to fall
 * back to the built-in $10/$200 whatever the user had configured.
 */
export function createCostTracker(dbPath?: string, budget?: BudgetConfig): CostTracker {
  // Both limits given: nothing to resolve, so a malformed env or config value cannot break
  // an explicit configuration (codex review; the smart client's needsBudget() rule).
  const explicit = budget?.dailyLimit !== undefined && budget.monthlyLimit !== undefined;
  return new CostTracker(dbPath, explicit ? budget : { ...resolveBudget(), ...budget });
}
