/**
 * AI Client - Backward Compatibility Layer
 *
 * This file maintains backward compatibility with Phase 1 code.
 * All functionality has been moved to src/ai-client/ directory.
 *
 * @deprecated Import from 'src/ai-client' instead
 */

// Re-export Phase 1 types and functions
export {
  AIClient,
  AITranslationRequest,
  AITranslationResponse,
  createAIClient,
} from './ai-client/index';

// Re-export Phase 2 types and functions (for vision capabilities)
export {
  AIVisionClient,
  AIVisionRequest,
  AIVisionResponse,
  VisionClassification,
  AIClientFactory,
  ClientType,
  // Preprocessor
  ImagePreprocessor,
  PreprocessorConfig,
  PreprocessedImage,
  createPreprocessor,
  // Cache
  AIVisionCache,
  CacheConfig,
  CacheEntry,
  CacheStats,
  createCache,
  // Cost tracker
  CostTracker,
  ProviderPricing,
  BudgetConfig,
  CostEntry,
  CostStats,
  BudgetStatus,
  createCostTracker,
  // Smart client
  SmartAIVisionClient,
  SmartClientConfig,
  createSmartClient,
} from './ai-client/index';
