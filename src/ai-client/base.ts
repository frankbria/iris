import { IrisConfig } from '../config';
import { Action } from '../translator';

/**
 * Request for translating natural language instructions to browser actions
 */
export interface AITranslationRequest {
  instruction: string;
  context?: {
    url?: string;
    currentPage?: string;
    previousActions?: Action[];
  };
}

/**
 * Response from AI translation containing actions and metadata
 */
export interface AITranslationResponse {
  actions: Action[];
  confidence: number;
  reasoning?: string;
}

/**
 * Request for AI vision analysis of visual changes
 */
export interface AIVisionRequest {
  baseline: Buffer;
  current: Buffer;
  context?: {
    url?: string;
    selector?: string;
    previousClassifications?: VisionClassification[];
  };
}

/**
 * Classification result from AI vision analysis
 */
export interface VisionClassification {
  severity: 'none' | 'minor' | 'moderate' | 'breaking';
  confidence: number;
  reasoning: string;
  categories: Array<'layout' | 'text' | 'color' | 'spacing' | 'content'>;
}

/**
 * Response from AI vision analysis
 */
export interface AIVisionResponse extends VisionClassification {
  suggestions?: string[];
}

/**
 * Base interface for all AI clients (text and vision)
 */
export interface AIClient {
  /**
   * Translate natural language instruction to browser actions
   */
  translateInstruction(request: AITranslationRequest): Promise<AITranslationResponse>;

  /**
   * Check if the client is available and configured
   */
  isAvailable(): Promise<boolean>;
}

/**
 * Extended interface for AI clients that support vision capabilities
 */
export interface AIVisionClient extends AIClient {
  /**
   * Analyze visual differences between two images
   */
  analyzeVisualDiff(request: AIVisionRequest): Promise<AIVisionResponse>;

  /**
   * Check if vision capabilities are available
   */
  supportsVision(): boolean;
}

/**
 * Abstract base class for AI clients providing common functionality
 */
export abstract class BaseAIClient implements AIClient {
  protected config: IrisConfig['ai'];

  constructor(config: IrisConfig['ai']) {
    this.config = config;
  }

  /**
   * Translate natural language instruction to browser actions
   * Must be implemented by concrete clients
   */
  abstract translateInstruction(
    request: AITranslationRequest
  ): Promise<AITranslationResponse>;

  /**
   * Check if the client is available
   * Must be implemented by concrete clients
   */
  abstract isAvailable(): Promise<boolean>;

  /**
   * Helper method to handle errors consistently
   */
  protected handleError(error: unknown, operation: string): AITranslationResponse {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${operation} error:`, error);
    return {
      actions: [],
      confidence: 0,
      reasoning: `Failed to ${operation}: ${message}`,
    };
  }

  /**
   * Helper method to validate configuration
   */
  protected validateConfig(requiredFields: string[]): void {
    for (const field of requiredFields) {
      if (!(field in this.config) || !this.config[field as keyof typeof this.config]) {
        throw new Error(`${field} not configured for AI provider`);
      }
    }
  }
}

/**
 * Abstract base class for AI clients with vision support
 */
export abstract class BaseAIVisionClient
  extends BaseAIClient
  implements AIVisionClient
{
  /**
   * Analyze visual differences between two images
   * Must be implemented by concrete vision clients
   */
  abstract analyzeVisualDiff(request: AIVisionRequest): Promise<AIVisionResponse>;

  /**
   * Check if vision capabilities are supported
   * Default implementation returns true for vision clients
   */
  supportsVision(): boolean {
    return true;
  }

  /**
   * Helper method to handle vision-specific errors
   */
  protected handleVisionError(error: unknown, operation: string): AIVisionResponse {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${operation} error:`, error);
    return {
      severity: 'none',
      confidence: 0,
      reasoning: `Failed to ${operation}: ${message}`,
      categories: [],
    };
  }
}
