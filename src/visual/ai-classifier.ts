/**
 * AI Visual Classifier - Refactored to use Phase 2A infrastructure
 *
 * This module provides backward-compatible interface while leveraging:
 * - SmartAIVisionClient for intelligent provider selection and fallback
 * - ImagePreprocessor for optimized image processing
 * - AIVisionCache for result caching
 * - CostTracker for budget management
 *
 * ADAPTER PATTERN: Maps between existing AIAnalysisRequest/Response types
 * and Phase 2A AIVisionRequest/Response types to maintain backward compatibility.
 */

import { IrisConfig } from '../config';
import { SmartAIVisionClient, SmartClientConfig } from '../ai-client/smart-client';
import { ImagePreprocessor } from '../ai-client/preprocessor';
import { AIVisionRequest, AIVisionResponse } from '../ai-client/base';
import { AIVisualAnalysis } from './types';

/**
 * AI Provider Types (backward compatibility)
 */
export type AIProvider = 'openai' | 'claude' | 'ollama';

/**
 * AI Provider Configuration (backward compatibility)
 */
export interface AIProviderConfig {
  provider: AIProvider;
  apiKey?: string;
  model?: string;
  baseURL?: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * Prepared image metadata (backward compatibility)
 */
export interface PreparedImageForAI {
  base64: string;
  mimeType: string;
  width: number;
  height: number;
}

/**
 * AI analysis request (PUBLIC INTERFACE - DO NOT CHANGE)
 */
export interface AIAnalysisRequest {
  baselineImage: Buffer;
  currentImage: Buffer;
  diffImage?: Buffer;
  context?: {
    testName?: string;
    url?: string;
    viewport?: { width: number; height: number };
    gitBranch?: string;
  };
}

/**
 * AI analysis response (PUBLIC INTERFACE - DO NOT CHANGE)
 */
export interface AIAnalysisResponse {
  classification: string;
  confidence: number;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  suggestions: string[];
  isIntentional: boolean;
  changeType: 'layout' | 'color' | 'content' | 'typography' | 'animation' | 'unknown';
  reasoning: string;
  regions?: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
    type: string;
    description: string;
  }>;
}

/**
 * AI Visual Classifier for semantic visual change analysis
 *
 * Refactored to use Phase 2A infrastructure while maintaining backward compatibility.
 * Uses SmartAIVisionClient for intelligent provider selection, caching, and cost tracking.
 */
export class AIVisualClassifier {
  private smartClient: SmartAIVisionClient;
  private preprocessor: ImagePreprocessor;
  private config: AIProviderConfig;
  private irisConfig: IrisConfig;

  /**
   * Create AI visual classifier with backward-compatible interface
   *
   * @param config - AI provider configuration (legacy format)
   */
  constructor(config: AIProviderConfig) {
    this.config = {
      maxTokens: 2048,
      temperature: 0.1,
      ...config,
    };

    // Validate configuration early to maintain backward compatibility with error handling
    this.validateProviderConfig(config);

    // Convert legacy AIProviderConfig to IrisConfig format (adapter pattern)
    this.irisConfig = this.convertToIrisConfig(config);

    // Initialize Phase 2A components
    this.preprocessor = new ImagePreprocessor({
      maxWidth: 2048,
      maxHeight: 2048,
      quality: 85,
      maintainAspectRatio: true,
      format: 'jpeg',
    });

    // Initialize smart client with default configuration
    const smartConfig: SmartClientConfig = {
      enableCache: true,
      enableCostTracking: true,
      enableFallback: true,
      fallbackChain: ['ollama', 'openai', 'anthropic'],
    };

    this.smartClient = new SmartAIVisionClient(this.irisConfig, smartConfig);
  }

  /**
   * Validate provider configuration (backward compatibility)
   * Throws errors matching the legacy implementation's expectations
   */
  private validateProviderConfig(config: AIProviderConfig): void {
    // Validate provider type
    const validProviders = ['openai', 'claude', 'ollama'];
    if (!validProviders.includes(config.provider)) {
      throw new Error(`Unsupported AI provider: ${config.provider}`);
    }

    // Validate OpenAI configuration
    if (config.provider === 'openai' && !config.apiKey) {
      throw new Error('OpenAI API key is required for provider "openai"');
    }

    // Validate Claude/Anthropic configuration
    if (config.provider === 'claude' && !config.apiKey) {
      throw new Error('Anthropic API key is required for provider "claude"');
    }

    // Ollama doesn't require API key validation
  }

  /**
   * Convert legacy AIProviderConfig to IrisConfig format
   * This adapter method bridges the old and new configuration systems
   */
  private convertToIrisConfig(config: AIProviderConfig): IrisConfig {
    // Map provider names (backward compatibility)
    let provider: 'openai' | 'anthropic' | 'ollama';
    if (config.provider === 'claude') {
      provider = 'anthropic';
    } else {
      provider = config.provider as 'openai' | 'anthropic' | 'ollama';
    }

    // Determine default model based on provider
    let model = config.model;
    if (!model) {
      switch (provider) {
        case 'openai':
          model = 'gpt-4o';
          break;
        case 'anthropic':
          model = 'claude-3-5-sonnet-20241022';
          break;
        case 'ollama':
          model = 'llava';
          break;
      }
    }

    return {
      ai: {
        provider,
        apiKey: config.apiKey,
        model,
        endpoint: config.baseURL,
      },
      watch: {
        patterns: ['**/*.{ts,tsx,js,jsx,html,css}'],
        debounceMs: 1000,
        ignore: ['node_modules/**', 'dist/**', '.git/**', 'coverage/**'],
      },
      browser: {
        headless: true,
        timeout: 30000,
      },
    };
  }

  /**
   * Prepare image for AI analysis (backward compatibility method)
   *
   * This method maintains the legacy interface but delegates to ImagePreprocessor
   *
   * @param imageBuffer - Image buffer to prepare
   * @param maxWidth - Maximum width (default: 1024)
   * @returns Prepared image metadata
   */
  async prepareImageForAI(imageBuffer: Buffer, maxWidth: number = 1024): Promise<PreparedImageForAI> {
    try {
      const processed = await this.preprocessor.preprocess(imageBuffer);

      return {
        base64: processed.base64,
        mimeType: 'image/jpeg',
        width: processed.dimensions.width,
        height: processed.dimensions.height,
      };
    } catch (error) {
      throw new Error(`Failed to prepare image for AI: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Analyze visual changes using Phase 2A infrastructure
   *
   * This method maintains the legacy interface while using SmartAIVisionClient internally
   *
   * @param request - AI analysis request
   * @returns AI analysis response
   */
  async analyzeChange(request: AIAnalysisRequest): Promise<AIAnalysisResponse> {
    try {
      // Build Phase 2A vision request with context
      const visionRequest: AIVisionRequest = {
        baseline: request.baselineImage,
        current: request.currentImage,
        context: {
          url: request.context?.url,
          selector: undefined, // Not used in legacy interface
          previousClassifications: undefined, // Not used in legacy interface
        },
      };

      // Use SmartAIVisionClient for intelligent analysis with caching and fallback
      const visionResponse = await this.smartClient.analyzeVisualDiff(visionRequest);

      // Map Phase 2A response to legacy response format (adapter pattern)
      return this.mapVisionResponseToAnalysisResponse(visionResponse, request.context);
    } catch (error) {
      // Return fallback response on error
      return this.createFallbackResponse(error);
    }
  }

  /**
   * Batch analyze multiple visual changes with concurrency control
   *
   * Leverages shared cache across batch for efficiency
   *
   * @param requests - Array of analysis requests
   * @returns Array of analysis responses
   */
  async batchAnalyze(requests: AIAnalysisRequest[]): Promise<AIAnalysisResponse[]> {
    // Process in parallel with concurrency limit to avoid rate limits
    const concurrency = 3; // Conservative limit for API rate limits

    // Dynamic import to avoid Jest ES module issues
    const pLimit = (await import('p-limit')).default;
    const limit = pLimit(concurrency);

    const tasks = requests.map(req =>
      limit(() => this.analyzeChange(req))
    );

    return Promise.all(tasks);
  }

  /**
   * Map Phase 2A AIVisionResponse to legacy AIAnalysisResponse
   *
   * This adapter method bridges the response formats:
   * - Severity mapping: none→low, minor→low, moderate→medium, breaking→critical
   * - Categories → changeType mapping
   * - Intentional logic: none/minor → true, moderate/breaking → false
   */
  private mapVisionResponseToAnalysisResponse(
    visionResponse: AIVisionResponse,
    context?: AIAnalysisRequest['context']
  ): AIAnalysisResponse {
    // Map severity levels
    const severity = this.mapSeverity(visionResponse.severity);

    // Determine if change is intentional based on severity
    const isIntentional = this.determineIntentionality(visionResponse.severity);

    // Map categories to primary change type
    const changeType = this.mapCategoriesToChangeType(visionResponse.categories);

    // Build classification string
    const classification = this.buildClassification(visionResponse.severity, isIntentional);

    // Build description with context
    const description = this.buildDescription(visionResponse, context);

    return {
      classification,
      confidence: visionResponse.confidence,
      description,
      severity,
      suggestions: visionResponse.suggestions || [],
      isIntentional,
      changeType,
      reasoning: visionResponse.reasoning,
      regions: undefined, // Phase 2A doesn't provide regions yet
    };
  }

  /**
   * Map Phase 2A severity to legacy severity levels
   */
  private mapSeverity(severity: 'none' | 'minor' | 'moderate' | 'breaking'): 'low' | 'medium' | 'high' | 'critical' {
    switch (severity) {
      case 'none':
        return 'low';
      case 'minor':
        return 'low';
      case 'moderate':
        return 'medium';
      case 'breaking':
        return 'critical';
      default:
        return 'medium';
    }
  }

  /**
   * Determine if change is intentional based on severity
   *
   * Logic: none/minor changes are likely intentional updates,
   * moderate/breaking changes are likely unintentional regressions
   */
  private determineIntentionality(severity: 'none' | 'minor' | 'moderate' | 'breaking'): boolean {
    return severity === 'none' || severity === 'minor';
  }

  /**
   * Map Phase 2A categories to primary change type
   */
  private mapCategoriesToChangeType(
    categories: Array<'layout' | 'text' | 'color' | 'spacing' | 'content'>
  ): 'layout' | 'color' | 'content' | 'typography' | 'animation' | 'unknown' {
    if (categories.length === 0) {
      return 'unknown';
    }

    // Priority order for determining primary change type
    if (categories.includes('layout') || categories.includes('spacing')) {
      return 'layout';
    }
    if (categories.includes('text')) {
      return 'typography';
    }
    if (categories.includes('color')) {
      return 'color';
    }
    if (categories.includes('content')) {
      return 'content';
    }

    // Default to first category or unknown
    const firstCategory = categories[0];
    if (firstCategory === 'text') return 'typography';
    if (firstCategory === 'spacing') return 'layout';
    return firstCategory as any || 'unknown';
  }

  /**
   * Build classification string from severity and intentionality
   */
  private buildClassification(
    severity: 'none' | 'minor' | 'moderate' | 'breaking',
    isIntentional: boolean
  ): string {
    if (severity === 'none') {
      return 'no-change';
    }
    if (isIntentional) {
      return 'intentional';
    }
    return 'regression';
  }

  /**
   * Build description with context information
   */
  private buildDescription(
    visionResponse: AIVisionResponse,
    context?: AIAnalysisRequest['context']
  ): string {
    let description = visionResponse.reasoning;

    // Add context if available
    if (context) {
      const contextParts: string[] = [];
      if (context.testName) {
        contextParts.push(`Test: ${context.testName}`);
      }
      if (context.url) {
        contextParts.push(`URL: ${context.url}`);
      }
      if (context.viewport) {
        contextParts.push(`Viewport: ${context.viewport.width}x${context.viewport.height}`);
      }

      if (contextParts.length > 0) {
        description = `${description}\n\nContext: ${contextParts.join(', ')}`;
      }
    }

    return description;
  }

  /**
   * Create fallback response on error
   */
  private createFallbackResponse(error: unknown): AIAnalysisResponse {
    const message = error instanceof Error ? error.message : 'Unknown error';

    return {
      classification: 'unknown',
      confidence: 0.5,
      description: `Failed to analyze visual changes: ${message}`,
      severity: 'medium',
      suggestions: [
        'Review the visual changes manually',
        'Check AI provider configuration',
        'Verify API keys and network connectivity',
      ],
      isIntentional: false,
      changeType: 'unknown',
      reasoning: `Analysis failed: ${message}`,
    };
  }

  /**
   * Get cache statistics from smart client
   */
  getCacheStats() {
    return this.smartClient.getCacheStats();
  }

  /**
   * Get cost statistics from smart client
   */
  getCostStats() {
    return this.smartClient.getCostStats();
  }

  /**
   * Get budget status from smart client
   */
  getBudgetStatus() {
    return this.smartClient.getBudgetStatus();
  }

  /**
   * Prepare multiple images for batch AI analysis (backward compatibility)
   *
   * @param images - Array of image buffers
   * @param maxWidth - Maximum width (default: 1024)
   * @returns Array of prepared images
   */
  async prepareImagesForAI(images: Buffer[], maxWidth: number = 1024): Promise<PreparedImageForAI[]> {
    return Promise.all(images.map(img => this.prepareImageForAI(img, maxWidth)));
  }

  /**
   * Convert AIAnalysisResponse to AIVisualAnalysis format (backward compatibility)
   *
   * This method maintains compatibility with code expecting the simplified
   * AIVisualAnalysis format (subset of AIAnalysisResponse).
   *
   * @param response - Full AI analysis response
   * @returns Simplified visual analysis format
   */
  toVisualAnalysis(response: AIAnalysisResponse): AIVisualAnalysis {
    return {
      classification: response.classification,
      confidence: response.confidence,
      description: response.description,
      severity: response.severity,
      suggestions: response.suggestions,
      regions: response.regions,
    };
  }

  /**
   * Close and cleanup resources
   */
  close(): void {
    this.smartClient.close();
  }
}
