/**
 * AI Client Module - Multimodal AI integration for IRIS
 *
 * This module provides abstraction for AI providers supporting both
 * text-based instruction translation (Phase 1) and vision-based
 * visual diff analysis (Phase 2).
 */

// Base types and interfaces
export {
  AIClient,
  AIVisionClient,
  AITranslationRequest,
  AITranslationResponse,
  AIVisionRequest,
  AIVisionResponse,
  VisionClassification,
  BaseAIClient,
  BaseAIVisionClient,
} from './base';

// Text client implementations
export {
  OpenAITextClient,
  AnthropicTextClient,
  OllamaTextClient,
} from './text';

// Vision client implementations
export {
  OpenAIVisionClient,
  AnthropicVisionClient,
  OllamaVisionClient,
} from './vision';

// Image preprocessor
export {
  ImagePreprocessor,
  PreprocessorConfig,
  PreprocessedImage,
  createPreprocessor,
} from './preprocessor';

// Cache
export {
  AIVisionCache,
  CacheConfig,
  CacheEntry,
  CacheStats,
  createCache,
} from './cache';

// Cost tracker
export {
  CostTracker,
  ProviderPricing,
  BudgetConfig,
  CostEntry,
  CostStats,
  BudgetStatus,
  createCostTracker,
} from './cost-tracker';

// Smart client
export {
  SmartAIVisionClient,
  SmartClientConfig,
  createSmartClient,
} from './smart-client';

// Factory
export { AIClientFactory, ClientType, createAIClient } from './factory';
