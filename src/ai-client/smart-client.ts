import { randomUUID } from 'crypto';
import * as path from 'path';
import { DEFAULT_BUDGET_LIMITS, IrisConfig, ProviderCredentials, resolveBudget } from '../config';
import { resolveDataDir } from '../data-dir';
import {
  AIResponseRejectedError,
  AIVisionClient,
  AIVisionRequest,
  AIVisionResponse,
  formatError,
} from './base';
import { AIClientFactory } from './factory';
import { AIVisionCache } from './cache';
import { CostTracker } from './cost-tracker';
import { ImagePreprocessor } from './preprocessor';
import { DEFAULT_MODELS, ModelProvider, ModelUnavailableError, resolveModel } from './models';

/**
 * Smart client configuration
 */
export interface SmartClientConfig {
  /**
   * Enable caching (default: true)
   */
  enableCache?: boolean;

  /**
   * Enable cost tracking (default: true)
   */
  enableCostTracking?: boolean;

  /**
   * Try other vendors when the configured one fails. Default: `irisConfig.ai.fallback`,
   * else off — a vendor the user did not choose is never billed unasked (#245).
   */
  enableFallback?: boolean;

  /**
   * Vendors to try after the configured provider, which always goes first
   * (default: ['ollama', 'openai', 'anthropic'])
   */
  fallbackChain?: string[];

  /**
   * The tenant this client works for (#255): its cache entries and ledger rows are
   * the org's, and its budget is the org's. Unset in local mode.
   */
  orgId?: string;

  /**
   * Cache configuration
   */
  cacheConfig?: {
    maxMemoryEntries?: number;
    ttlMs?: number;
    dbPath?: string;
  };

  /**
   * Cost tracker configuration
   */
  costConfig?: {
    dbPath?: string;
    dailyLimit?: number;
    monthlyLimit?: number;
  };
}

type ResolvedConfig = Required<
  Omit<SmartClientConfig, 'cacheConfig' | 'costConfig' | 'enableFallback' | 'orgId'>
> & {
  enableFallback?: boolean;
  orgId?: string;
  cacheConfig: { maxMemoryEntries: number; ttlMs: number; dbPath: string };
  costConfig: { dbPath: string; dailyLimit: number; monthlyLimit: number };
};

/**
 * Default smart client configuration, resolved when a client is built rather
 * than at import, so it follows the environment of the moment.
 *
 * The cache and cost ledger live in the data dir, not the cwd (#241): a
 * cwd-relative ledger gave every directory its own fresh daily budget, and in
 * the read-only container it resolved under /app.
 */
function defaultConfig(): ResolvedConfig {
  const cacheDir = path.join(resolveDataDir(), 'cache');
  return {
    enableCache: true,
    enableCostTracking: true,
    fallbackChain: ['ollama', 'openai', 'anthropic'],
    cacheConfig: {
      maxMemoryEntries: 100,
      ttlMs: 30 * 24 * 60 * 60 * 1000,
      dbPath: path.join(cacheDir, 'vision-cache.db'),
    },
    costConfig: {
      dbPath: path.join(cacheDir, 'cost-tracking.db'),
      ...DEFAULT_BUDGET_LIMITS,
    },
  };
}

/**
 * Smart AI vision client with caching, cost tracking, and fallback
 *
 * 1. Check cache first
 * 2. Call the configured provider
 * 3. Only if fallback is enabled, try the rest of the chain in order
 * 4. Track costs and enforce budget limits
 */
export class SmartAIVisionClient {
  private config: ResolvedConfig;
  private cache?: AIVisionCache;
  private costTracker?: CostTracker;
  private preprocessor: ImagePreprocessor;
  /**
   * Separate pipeline for the diff mask, because it is a signal and not a photo.
   *
   * `generateDiffImage` emits RGBA PNG where pixelmatch marks unchanged pixels
   * *transparent*. The default preprocessor re-encodes to JPEG, which has no
   * alpha channel — so the mask gets flattened and its hard region edges are
   * blurred away by lossy 8x8 blocks. That destroys precisely the localization
   * the third image exists to carry, while still producing a plausible-looking
   * payload. PNG keeps it lossless; the size cap still applies.
   */
  private diffPreprocessor: ImagePreprocessor;
  private clients: Map<string, AIVisionClient>;
  private irisConfig: IrisConfig;

  constructor(irisConfig: IrisConfig, smartConfig: SmartClientConfig = {}) {
    const defaults = defaultConfig();
    this.config = {
      ...defaults,
      ...smartConfig,
      cacheConfig: { ...defaults.cacheConfig, ...smartConfig.cacheConfig },
      costConfig: {
        ...defaults.costConfig,
        // Only when it can matter: a malformed variable should not break a
        // client that tracks no cost, or one given both limits explicitly.
        ...(this.needsBudget(smartConfig) ? resolveBudget() : {}),
        ...smartConfig.costConfig,
      },
    };
    this.irisConfig = irisConfig;
    this.clients = new Map();
    this.preprocessor = new ImagePreprocessor();
    this.diffPreprocessor = new ImagePreprocessor({ format: 'png' });

    // Initialize cache
    if (this.config.enableCache) {
      this.cache = new AIVisionCache(this.config.cacheConfig);
    }

    // Initialize cost tracker
    if (this.config.enableCostTracking) {
      // One client per run: its own run id scopes getCostStats() (#255), so a run's
      // cost summary does not report other runs, or other orgs, sharing the ledger.
      this.costTracker = new CostTracker(
        this.config.costConfig.dbPath,
        {
          dailyLimit: this.config.costConfig.dailyLimit,
          monthlyLimit: this.config.costConfig.monthlyLimit,
        },
        { orgId: this.config.orgId, runId: randomUUID() },
      );
    }
  }

  private needsBudget({ enableCostTracking = true, costConfig }: SmartClientConfig): boolean {
    return (
      enableCostTracking &&
      (costConfig?.dailyLimit === undefined || costConfig?.monthlyLimit === undefined)
    );
  }

  /**
   * Analyze visual diff with smart provider selection
   *
   * @param request - Vision analysis request
   * @returns Vision analysis response
   */
  async analyzeVisualDiff(request: AIVisionRequest): Promise<AIVisionResponse> {
    // Preprocess images
    const baselineProcessed = await this.preprocessor.preprocess(request.baseline);
    const currentProcessed = await this.preprocessor.preprocess(request.current);
    // Size-cap the diff and hash it for the cache key (issue #124). An empty
    // buffer is treated as no diff at all: sharp throws on zero bytes, which
    // would fail the whole analysis over an image that carries no signal.
    const diffProcessed = request.diff?.length
      ? await this.diffPreprocessor.preprocess(request.diff)
      : undefined;

    // The configured provider first, always; other vendors only on opt-in (#245).
    // `=== true`: ai.fallback comes from untyped JSON, where "false" is truthy.
    const configured = this.irisConfig.ai.provider;
    const fallback = (this.config.enableFallback ?? this.irisConfig.ai.fallback) === true;
    const providers = fallback
      ? [configured, ...this.config.fallbackChain.filter((p) => p !== configured)]
      : [configured];

    // Context influences the analysis, so it is part of the cache identity.
    const contextKey = request.context ? JSON.stringify(request.context) : '';

    let lastError: Error | null = null;

    for (const providerName of providers) {
      // Resolve the provider+model pair once per attempt so cache read, cache
      // write, and cost tracking all key on the exact same value.
      //
      // Async since #184: this consults the provider's live model list (one
      // memoized call per provider per process) so a pin the vendor retired is
      // replaced rather than requested. A ModelUnavailableError means the user
      // named a model that does not exist — see the catch below.
      let model: string;
      try {
        model = await this.resolveModel(providerName);
      } catch (error) {
        if (error instanceof ModelUnavailableError) throw error;
        lastError = error instanceof Error ? error : new Error(String(error));
        continue;
      }

      // Derive the key ONCE per attempt too. Two separate derivations for the
      // read and the write is how they silently drifted apart in issue #60 —
      // every added key input has to be remembered in both places.
      const cacheKey = this.cache?.generateKey(
        baselineProcessed.hash,
        currentProcessed.hash,
        providerName,
        model,
        contextKey,
        diffProcessed?.hash ?? '',
        this.config.orgId ?? '',
      );

      // Check cache for this provider+model (cache hits are free, so this runs
      // before availability/budget checks)
      if (this.cache && cacheKey) {
        const cached = this.cache.get(cacheKey);
        if (cached) {
          if (this.costTracker) {
            this.costTracker.trackOperation(providerName, model, true);
          }
          return cached;
        }
      }

      // Held from before the call until its reply is recorded (#244), so the
      // budget counts calls still in flight.
      let reservation: number | undefined;
      let result: AIVisionResponse;
      try {
        // Get or create client for this provider
        const client = this.getClient(providerName, model);

        // Check if provider is available
        const available = await client.isAvailable();
        if (!available) {
          lastError ??= new Error(`${providerName} is not available`);
          continue;
        }

        // Refuses a billable call once spend plus open reservations reaches the
        // limit; free providers (#68) and unpriced-but-paid models (#126) are
        // judged inside the tracker.
        reservation = this.costTracker?.reserve(providerName, model);

        result = await client.analyzeVisualDiff({
          baseline: baselineProcessed.buffer,
          current: currentProcessed.buffer,
          ...(diffProcessed ? { diff: diffProcessed.buffer } : {}),
          context: request.context,
        });
      } catch (error) {
        // A reply IRIS rejected was still billed; anything else never got one.
        if (reservation !== undefined) {
          if (error instanceof AIResponseRejectedError) {
            this.costTracker!.settle(reservation, error.usage);
          } else {
            this.costTracker!.release(reservation);
          }
        }
        // "That model does not exist" is the user's to fix, and stepping to the
        // next vendor only reprints it as "all providers failed" (#184). Keep
        // the guard here at the swallow site, not only where it is thrown.
        if (error instanceof ModelUnavailableError) throw error;
        lastError = error instanceof Error ? error : new Error(String(error));
        // Continue to next provider in fallback chain
        continue;
      }

      // From here on the call is paid for and answered. Nothing below may send
      // it to the next vendor, which would pay for the same answer twice.
      if (reservation !== undefined) {
        this.costTracker!.settle(reservation, result.usage);
      }

      if (this.cache && cacheKey) {
        try {
          this.cache.set(cacheKey, result, providerName, model);
        } catch (error) {
          console.warn('⚠️  Could not cache the vision result:', formatError(error));
        }
      }

      return result;
    }

    // With fallback off only one vendor was tried; say what happened to it.
    if (providers.length === 1 && lastError) throw lastError;
    throw new Error(`All providers failed. Last error: ${lastError?.message || 'Unknown error'}`);
  }

  /**
   * Get or create client for provider
   */
  private getClient(providerName: string, model: string): AIVisionClient {
    let client = this.clients.get(providerName);

    if (!client) {
      // Credentials are per-vendor, but the fallback chain steps across vendors.
      // Spreading `...this.irisConfig.ai` wholesale would attach the configured
      // provider's key to every other provider's client — e.g. an Anthropic user
      // falling back through OpenAI would send `Authorization: Bearer sk-ant-...`
      // to api.openai.com. `credentialsFor` scopes the credential (and endpoint)
      // to the provider it was configured for; without a key `isAvailable()` is
      // false, so the mismatched provider is skipped rather than contacted (#74).
      const scoped = this.credentialsFor(providerName);

      // Create config for this provider
      const providerConfig: IrisConfig = {
        ...this.irisConfig,
        ai: {
          ...this.irisConfig.ai,
          provider: providerName as 'openai' | 'anthropic' | 'ollama',
          // The already-resolved model, passed in rather than re-derived, so the
          // request body cannot drift from the cache key and cost row.
          model,
          apiKey: scoped.apiKey,
          endpoint: scoped.endpoint,
        },
      };

      client = AIClientFactory.create(providerConfig, 'vision') as AIVisionClient;
      this.clients.set(providerName, client);
    }

    return client;
  }

  /**
   * Resolve the model to use for a provider.
   *
   * Honors the configured `irisConfig.ai.model` when the provider matches the
   * configured provider; otherwise starts from that provider's vision pin. The
   * result is then checked against the provider's live model list (#184), which
   * is where a retired pin gets replaced and a nonexistent user model becomes a
   * {@link ModelUnavailableError} instead of a silent hop to the next vendor.
   *
   * @throws {ModelUnavailableError} for a configured model the provider does not serve.
   */
  private async resolveModel(providerName: string): Promise<string> {
    const provider = providerName as ModelProvider;
    const configured =
      providerName === this.irisConfig.ai.provider && this.irisConfig.ai.model
        ? this.irisConfig.ai.model
        : undefined;
    const model = configured ?? DEFAULT_MODELS.vision[provider] ?? '';
    if (!model) return '';

    return resolveModel({
      provider,
      kind: 'vision',
      model,
      creds: this.credentialsFor(providerName),
    });
  }

  /**
   * The credential the probe (and the client) should use for a provider —
   * per-vendor entry first, then the top-level one but only for the provider it
   * was configured for. Same scoping rule as {@link getClient}: a key must never
   * be sent to a vendor it does not belong to (#74).
   */
  private credentialsFor(providerName: string): { apiKey?: string; endpoint?: string } {
    const isConfiguredProvider = providerName === this.irisConfig.ai.provider;
    const scoped =
      this.irisConfig.ai.credentials?.[providerName as keyof ProviderCredentials] ?? {};
    return {
      apiKey: scoped.apiKey ?? (isConfiguredProvider ? this.irisConfig.ai.apiKey : undefined),
      endpoint: scoped.endpoint ?? (isConfiguredProvider ? this.irisConfig.ai.endpoint : undefined),
    };
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    return this.cache?.getStats();
  }

  /**
   * Get cost statistics
   */
  getCostStats() {
    return this.costTracker?.getStats();
  }

  /**
   * Get budget status
   */
  getBudgetStatus() {
    return this.costTracker?.getBudgetStatus();
  }

  /**
   * Close and cleanup resources
   */
  close(): void {
    if (this.cache) {
      this.cache.close();
    }
    if (this.costTracker) {
      this.costTracker.close();
    }
  }
}

/**
 * Create a smart AI vision client
 */
export function createSmartClient(
  irisConfig: IrisConfig,
  smartConfig?: SmartClientConfig,
): SmartAIVisionClient {
  return new SmartAIVisionClient(irisConfig, smartConfig);
}
