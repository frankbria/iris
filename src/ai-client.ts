import { IrisConfig } from './config';
import { Action } from './translator';

export interface AITranslationRequest {
  instruction: string;
  context?: {
    url?: string;
    currentPage?: string;
    previousActions?: Action[];
  };
}

export interface AITranslationResponse {
  actions: Action[];
  confidence: number;
  reasoning?: string;
}

export interface AIClient {
  translateInstruction(request: AITranslationRequest): Promise<AITranslationResponse>;
  isAvailable(): Promise<boolean>;
}

class OpenAIClient implements AIClient {
  private config: IrisConfig['ai'];

  constructor(config: IrisConfig['ai']) {
    this.config = config;
  }

  async translateInstruction(request: AITranslationRequest): Promise<AITranslationResponse> {
    if (!this.config.apiKey) {
      throw new Error('OpenAI API key not configured');
    }

    const { OpenAI } = await import('openai');
    const openai = new OpenAI({ apiKey: this.config.apiKey });

    const systemPrompt = `You are an expert at translating natural language instructions into structured browser automation actions.

Available action types:
- click: { type: 'click', selector: string }
- fill: { type: 'fill', selector: string, text: string }
- navigate: { type: 'navigate', url: string }

Guidelines:
- Use CSS selectors for targeting elements (prefer data-testid, id, or semantic selectors)
- Be specific with selectors to avoid ambiguity
- Break complex instructions into multiple actions
- If an instruction is unclear, ask for clarification in the reasoning

Respond with valid JSON matching this schema:
{
  "actions": Action[],
  "confidence": number (0-1),
  "reasoning": string
}`;

    const userPrompt = `Translate this instruction into browser actions: "${request.instruction}"

${request.context ? `Context:
- URL: ${request.context.url || 'unknown'}
- Current page: ${request.context.currentPage || 'unknown'}
- Previous actions: ${JSON.stringify(request.context.previousActions || [])}` : ''}`;

    try {
      const response = await openai.chat.completions.create({
        model: this.config.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.1,
        max_tokens: 1000,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('No response from OpenAI');
      }

      const parsed = JSON.parse(content);
      return {
        actions: parsed.actions || [],
        confidence: parsed.confidence || 0.5,
        reasoning: parsed.reasoning,
      };
    } catch (error) {
      console.error('OpenAI translation error:', error);
      return {
        actions: [],
        confidence: 0,
        reasoning: `Failed to translate: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  async isAvailable(): Promise<boolean> {
    return !!this.config.apiKey;
  }
}

class AnthropicClient implements AIClient {
  private config: IrisConfig['ai'];

  constructor(config: IrisConfig['ai']) {
    this.config = config;
  }

  async translateInstruction(request: AITranslationRequest): Promise<AITranslationResponse> {
    // Note: This is a placeholder for Anthropic integration
    // In a real implementation, you would use the Anthropic SDK
    console.warn('Anthropic client not yet implemented, falling back to pattern matching');
    return {
      actions: [],
      confidence: 0,
      reasoning: 'Anthropic client not yet implemented',
    };
  }

  async isAvailable(): Promise<boolean> {
    return false; // Not implemented yet
  }
}

class OllamaClient implements AIClient {
  private config: IrisConfig['ai'];

  constructor(config: IrisConfig['ai']) {
    this.config = config;
  }

  async translateInstruction(request: AITranslationRequest): Promise<AITranslationResponse> {
    if (!this.config.endpoint) {
      throw new Error('Ollama endpoint not configured');
    }

    try {
      const response = await fetch(`${this.config.endpoint}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.config.model,
          prompt: `Translate this natural language instruction into browser automation actions: "${request.instruction}"

Available actions: click, fill, navigate
Respond with JSON: {"actions": [...], "confidence": 0.8, "reasoning": "..."}`,
          stream: false,
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama request failed: ${response.status}`);
      }

      const data = await response.json();
      const parsed = JSON.parse(data.response);

      return {
        actions: parsed.actions || [],
        confidence: parsed.confidence || 0.5,
        reasoning: parsed.reasoning,
      };
    } catch (error) {
      console.error('Ollama translation error:', error);
      return {
        actions: [],
        confidence: 0,
        reasoning: `Failed to translate with Ollama: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  async isAvailable(): Promise<boolean> {
    if (!this.config.endpoint) return false;

    try {
      const response = await fetch(`${this.config.endpoint}/api/tags`);
      return response.ok;
    } catch {
      return false;
    }
  }
}

export function createAIClient(config: IrisConfig): AIClient {
  switch (config.ai.provider) {
    case 'openai':
      return new OpenAIClient(config.ai);
    case 'anthropic':
      return new AnthropicClient(config.ai);
    case 'ollama':
      return new OllamaClient(config.ai);
    default:
      throw new Error(`Unsupported AI provider: ${config.ai.provider}`);
  }
}