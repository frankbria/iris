import { IrisConfig } from '../config';
import {
  AIVisionClient,
  AIVisionRequest,
  AIVisionResponse,
} from './base';
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
  cacheConfig: {
    maxMemoryEntries: 100,
    ttlMs: 30 * 24 * 60 * 60 * 1000,
    dbPath: './data/vision-cache.db',
  },
  costConfig: {
    dbPath: './data/cost-tracking.db',
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

    // Initialize cache
    if (this.config.enableCache) {
      this.cache = new AIVisionCache(this.config.cacheConfig);
    }

    // Initialize cost tracker
    if (this.config.enableCostTracking) {
      this.costTracker = new CostTracker(
        this.config.costConfig.dbPath,
        {
          dailyLimit: this.config.costConfig.dailyLimit,
          monthlyLimit: this.config.costConfig.monthlyLimit,
        }
      );
    }
  }

  /**
   * Analyze visual diff with smart provider selection
   *
   * @param request - Vision analysis request
   * @returns Vision analysis response
   */
  async analyzeVisualDiff(
    request: AIVisionRequest
  ): Promise<AIVisionResponse> {
    // Preprocess images
    const baselineProcessed = await this.preprocessor.preprocess(
      request.baseline
    );
    const currentProcessed = await this.preprocessor.preprocess(
      request.current
    );

    // Check cache
    if (this.cache) {
      const cacheKey = this.cache.generateKey(
        baselineProcessed.hash,
        currentProcessed.hash,
        this.irisConfig.ai.provider,
        this.irisConfig.ai.model || ''
      );

      const cached = this.cache.get(cacheKey);
      if (cached) {
        // Track cached operation (no cost)
        if (this.costTracker) {
          this.costTracker.trackOperation(
            this.irisConfig.ai.provider,
            this.irisConfig.ai.model || '',
            true
          );
        }
        return cached;
      }
    }

    // Try provider chain with fallback
    const providers = this.config.enableFallback
      ? this.config.fallbackChain
      : [this.irisConfig.ai.provider];

    let lastError: Error | null = null;

    for (const providerName of providers) {
      try {
        // Get or create client for this provider
        const client = this.getClient(providerName);

        // Check if provider is available
        const available = await client.isAvailable();
        if (!available) {
          continue;
        }

        // Check budget before making API call
        if (this.costTracker) {
          const budgetStatus = this.costTracker.getBudgetStatus();
          if (budgetStatus.circuitBreakerTriggered) {
            throw new Error(
              'Budget limit exceeded - circuit breaker activated'
            );
          }
        }

        // Make API call
        const result = await client.analyzeVisualDiff({
          baseline: baselineProcessed.buffer,
          current: currentProcessed.buffer,
          context: request.context,
        });

        // Track cost
        if (this.costTracker) {
          this.costTracker.trackOperation(
            providerName,
            this.getModelForProvider(providerName),
            false
          );
        }

        // Cache result
        if (this.cache) {
          const cacheKey = this.cache.generateKey(
            baselineProcessed.hash,
            currentProcessed.hash,
            providerName,
            this.getModelForProvider(providerName)
          );
          this.cache.set(
            cacheKey,
            result,
            providerName,
            this.getModelForProvider(providerName)
          );
        }

        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        // Continue to next provider in fallback chain
        continue;
      }
    }

    // All providers failed
    throw new Error(
      `All providers failed. Last error: ${lastError?.message || 'Unknown error'}`
    );
  }

  /**
   * Get or create client for provider
   */
  private getClient(providerName: string): AIVisionClient {
    let client = this.clients.get(providerName);

    if (!client) {
      // Create config for this provider
      const providerConfig: IrisConfig = {
        ...this.irisConfig,
        ai: {
          ...this.irisConfig.ai,
          provider: providerName as 'openai' | 'anthropic' | 'ollama',
          model: this.getModelForProvider(providerName),
        },
      };

      client = AIClientFactory.create(providerConfig, 'vision') as AIVisionClient;
      this.clients.set(providerName, client);
    }

    return client;
  }

  /**
   * Get default model for provider
   */
  private getModelForProvider(providerName: string): string {
    switch (providerName) {
      case 'openai':
        return 'gpt-4o';
      case 'anthropic':
        return 'claude-3-5-sonnet-20241022';
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
  smartConfig?: SmartClientConfig
): SmartAIVisionClient {
  return new SmartAIVisionClient(irisConfig, smartConfig);
}
