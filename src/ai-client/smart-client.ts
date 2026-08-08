import { IrisConfig, ProviderCredentials } from '../config';
import { AIVisionClient, AIVisionRequest, AIVisionResponse } from './base';
import { AIClientFactory } from './factory';
import { AIVisionCache } from './cache';
import { CostTracker } from './cost-tracker';
import { ImagePreprocessor } from './preprocessor';

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
   * Enable automatic fallback (default: true)
   */
  enableFallback?: boolean;

  /**
   * Fallback chain order (default: ['ollama', 'openai', 'anthropic'])
   */
  fallbackChain?: string[];

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

/**
 * Default smart client configuration
 */
const DEFAULT_CONFIG: Required<Omit<SmartClientConfig, 'cacheConfig' | 'costConfig'>> & {
  cacheConfig: { maxMemoryEntries: number; ttlMs: number; dbPath: string };
  costConfig: { dbPath: string; dailyLimit: number; monthlyLimit: number };
} = {
  enableCache: true,
  enableCostTracking: true,
  enableFallback: true,
  fallbackChain: ['ollama', 'openai', 'anthropic'],
  // These live under `.iris/` alongside baselines/screenshots/reports: it is
  // already gitignored, whereas the previous `./data/` default was not — users
  // would have committed their cache and cost history (issue #111).
  cacheConfig: {
    maxMemoryEntries: 100,
    ttlMs: 30 * 24 * 60 * 60 * 1000,
    dbPath: '.iris/cache/vision-cache.db',
  },
  costConfig: {
    dbPath: '.iris/cache/cost-tracking.db',
    dailyLimit: 10.0,
    monthlyLimit: 200.0,
  },
};

/**
 * Smart AI vision client with caching, cost tracking, and fallback
 *
 * Implements intelligent provider selection and cost optimization:
 * 1. Check cache first
 * 2. Try local provider (Ollama) if available
 * 3. Fall back to cloud providers based on budget
 * 4. Track costs and enforce budget limits
 */
export class SmartAIVisionClient {
  private config: typeof DEFAULT_CONFIG;
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
    this.config = {
      ...DEFAULT_CONFIG,
      ...smartConfig,
      cacheConfig: { ...DEFAULT_CONFIG.cacheConfig, ...smartConfig.cacheConfig },
      costConfig: { ...DEFAULT_CONFIG.costConfig, ...smartConfig.costConfig },
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
      this.costTracker = new CostTracker(this.config.costConfig.dbPath, {
        dailyLimit: this.config.costConfig.dailyLimit,
        monthlyLimit: this.config.costConfig.monthlyLimit,
      });
    }
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

    // Try provider chain with fallback
    const providers = this.config.enableFallback
      ? this.config.fallbackChain
      : [this.irisConfig.ai.provider];

    // Context influences the analysis, so it is part of the cache identity.
    const contextKey = request.context ? JSON.stringify(request.context) : '';

    let lastError: Error | null = null;

    for (const providerName of providers) {
      // Resolve the provider+model pair once per attempt so cache read, cache
      // write, and cost tracking all key on the exact same value.
      const model = this.resolveModel(providerName);

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

      try {
        // Get or create client for this provider
        const client = this.getClient(providerName);

        // Check if provider is available
        const available = await client.isAvailable();
        if (!available) {
          continue;
        }

        // Check budget before making API call — billable operations only (issue
        // #68): free providers (Ollama, registered at 0) proceed regardless.
        //
        // `isBudgetGated` rather than `getPricing() > 0` (issue #126): the
        // latter treats a model nobody priced as free, which is the one case
        // where guessing wrong costs real money. Token-rate-only registrations
        // now count as billable too — the per-call price is unknown before the
        // call, but the model is still paid.
        if (this.costTracker && this.costTracker.isBudgetGated(providerName, model)) {
          const budgetStatus = this.costTracker.getBudgetStatus();
          if (budgetStatus.circuitBreakerTriggered) {
            throw new Error('Budget limit exceeded - circuit breaker activated');
          }
        }

        // Make API call
        const result = await client.analyzeVisualDiff({
          baseline: baselineProcessed.buffer,
          current: currentProcessed.buffer,
          ...(diffProcessed ? { diff: diffProcessed.buffer } : {}),
          context: request.context,
        });

        // Track cost using real token usage when the provider reported it
        // (falls back to flat per-image pricing inside trackOperation).
        if (this.costTracker) {
          this.costTracker.trackOperation(providerName, model, false, result.usage);
        }

        // Cache result
        if (this.cache && cacheKey) {
          this.cache.set(cacheKey, result, providerName, model);
        }

        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        // Continue to next provider in fallback chain
        continue;
      }
    }

    // All providers failed
    throw new Error(`All providers failed. Last error: ${lastError?.message || 'Unknown error'}`);
  }

  /**
   * Get or create client for provider
   */
  private getClient(providerName: string): AIVisionClient {
    let client = this.clients.get(providerName);

    if (!client) {
      // Credentials are per-vendor, but the fallback chain steps across vendors.
      // Spreading `...this.irisConfig.ai` wholesale would attach the configured
      // provider's key to every other provider's client — e.g. an Anthropic user
      // falling back through OpenAI would send `Authorization: Bearer sk-ant-...`
      // to api.openai.com. Scope the credential (and endpoint) to the provider it
      // was configured for; without a key `isAvailable()` is false, so the
      // mismatched provider is skipped rather than contacted. See #74.
      const isConfiguredProvider = providerName === this.irisConfig.ai.provider;

      // A per-provider credential, when supplied, is the authoritative one for
      // that vendor — it is the only thing that lets the chain reach a provider
      // other than the configured one. Absent an entry, fall back to the
      // top-level credential but ONLY for the provider it was configured for.
      const scoped =
        this.irisConfig.ai.credentials?.[providerName as keyof ProviderCredentials] ?? {};

      // Create config for this provider
      const providerConfig: IrisConfig = {
        ...this.irisConfig,
        ai: {
          ...this.irisConfig.ai,
          provider: providerName as 'openai' | 'anthropic' | 'ollama',
          model: this.resolveModel(providerName),
          apiKey: scoped.apiKey ?? (isConfiguredProvider ? this.irisConfig.ai.apiKey : undefined),
          endpoint:
            scoped.endpoint ?? (isConfiguredProvider ? this.irisConfig.ai.endpoint : undefined),
        },
      };

      client = AIClientFactory.create(providerConfig, 'vision') as AIVisionClient;
      this.clients.set(providerName, client);
    }

    return client;
  }

  /**
   * Resolve the model to use for a provider. Honors the configured
   * `irisConfig.ai.model` when the provider matches the configured provider;
   * otherwise falls back to the provider's default model.
   */
  private resolveModel(providerName: string): string {
    if (providerName === this.irisConfig.ai.provider && this.irisConfig.ai.model) {
      return this.irisConfig.ai.model;
    }
    return this.getModelForProvider(providerName);
  }

  /**
   * Get default model for provider
   */
  private getModelForProvider(providerName: string): string {
    switch (providerName) {
      case 'openai':
        return 'gpt-4o';
      case 'anthropic':
        return 'claude-sonnet-5';
      case 'ollama':
        return 'llava';
      default:
        return '';
    }
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
