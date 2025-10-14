import { IrisConfig } from '../config';
import { AIClient, AIVisionClient } from './base';
import {
  OpenAITextClient,
  AnthropicTextClient,
  OllamaTextClient,
} from './text';
import {
  OpenAIVisionClient,
  AnthropicVisionClient,
  OllamaVisionClient,
} from './vision';

/**
 * Client type - text for instruction translation, vision for visual analysis
 */
export type ClientType = 'text' | 'vision';

/**
 * Factory for creating AI clients based on provider and capability
 */
export class AIClientFactory {
  /**
   * Create an AI client for the specified provider and type
   */
  static create(config: IrisConfig, type: ClientType = 'text'): AIClient {
    if (type === 'text') {
      return this.createTextClient(config);
    } else {
      return this.createVisionClient(config);
    }
  }

  /**
   * Create a text-only AI client
   */
  private static createTextClient(config: IrisConfig): AIClient {
    switch (config.ai.provider) {
      case 'openai':
        return new OpenAITextClient(config.ai);
      case 'anthropic':
        return new AnthropicTextClient(config.ai);
      case 'ollama':
        return new OllamaTextClient(config.ai);
      default:
        throw new Error(`Unsupported AI provider: ${config.ai.provider}`);
    }
  }

  /**
   * Create a vision-capable AI client
   */
  private static createVisionClient(config: IrisConfig): AIVisionClient {
    switch (config.ai.provider) {
      case 'openai':
        return new OpenAIVisionClient(config.ai);
      case 'anthropic':
        return new AnthropicVisionClient(config.ai);
      case 'ollama':
        return new OllamaVisionClient(config.ai);
      default:
        throw new Error(
          `Unsupported AI provider for vision: ${config.ai.provider}`
        );
    }
  }

  /**
   * Check if the specified provider supports vision capabilities
   */
  static supportsVision(config: IrisConfig): boolean {
    try {
      const client = this.createVisionClient(config);
      return client.supportsVision();
    } catch {
      return false;
    }
  }
}

/**
 * Legacy factory function for backward compatibility with Phase 1
 * @deprecated Use AIClientFactory.create() instead
 */
export function createAIClient(config: IrisConfig): AIClient {
  return AIClientFactory.create(config, 'text');
}
