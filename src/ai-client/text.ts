import { IrisConfig } from '../config';
import { BaseAIClient, AITranslationRequest, AITranslationResponse, formatError } from './base';
import { withRetry, fetchWithTimeout, DEFAULT_TIMEOUT_MS, DEFAULT_RETRY_CONFIG } from './retry';

/**
 * OpenAI client for text-based instruction translation
 */
export class OpenAITextClient extends BaseAIClient {
  constructor(config: IrisConfig['ai']) {
    super(config);
  }

  async translateInstruction(request: AITranslationRequest): Promise<AITranslationResponse> {
    if (!this.config.apiKey) {
      throw new Error('OpenAI API key not configured');
    }

    const { OpenAI } = await import('openai');
    const openai = new OpenAI({
      apiKey: this.config.apiKey,
      timeout: this.config.timeout ?? DEFAULT_TIMEOUT_MS,
      maxRetries: 0, // retries are driven by our withRetry below
    });

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

${
  request.context
    ? `Context:
- URL: ${request.context.url || 'unknown'}
- Current page: ${request.context.currentPage || 'unknown'}
- Previous actions: ${JSON.stringify(request.context.previousActions || [])}`
    : ''
}`;

    try {
      const response = await withRetry(
        () =>
          openai.chat.completions.create({
            model: this.config.model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            temperature: 0.1,
            max_tokens: 1000,
          }),
        this.config.retryConfig ?? DEFAULT_RETRY_CONFIG,
      );

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
      console.error('OpenAI translation error:', formatError(error));
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

/**
 * Anthropic Claude client for text-based instruction translation
 */
export class AnthropicTextClient extends BaseAIClient {
  constructor(config: IrisConfig['ai']) {
    super(config);
  }

  async translateInstruction(request: AITranslationRequest): Promise<AITranslationResponse> {
    if (!this.config.apiKey) {
      throw new Error('Anthropic API key not configured');
    }

    const { Anthropic } = await import('@anthropic-ai/sdk');
    const anthropic = new Anthropic({
      apiKey: this.config.apiKey,
      timeout: this.config.timeout ?? DEFAULT_TIMEOUT_MS,
      maxRetries: 0, // retries are driven by our withRetry below
    });

    // Claude uses a top-level `system` field rather than a system-role message.
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

${
  request.context
    ? `Context:
- URL: ${request.context.url || 'unknown'}
- Current page: ${request.context.currentPage || 'unknown'}
- Previous actions: ${JSON.stringify(request.context.previousActions || [])}`
    : ''
}`;

    try {
      const response = await withRetry(
        () =>
          anthropic.messages.create({
            model: this.config.model,
            max_tokens: 1000,
            temperature: 0.1,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }],
          }),
        this.config.retryConfig ?? DEFAULT_RETRY_CONFIG,
      );

      const content = response.content[0];
      if (!content || content.type !== 'text') {
        throw new Error('Unexpected response type from Anthropic');
      }

      const parsed = JSON.parse(content.text);
      return {
        actions: parsed.actions || [],
        confidence: parsed.confidence || 0.5,
        reasoning: parsed.reasoning,
      };
    } catch (error) {
      console.error('Anthropic translation error:', formatError(error));
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

/**
 * Ollama client for text-based instruction translation using local models
 */
export class OllamaTextClient extends BaseAIClient {
  constructor(config: IrisConfig['ai']) {
    super(config);
  }

  async translateInstruction(request: AITranslationRequest): Promise<AITranslationResponse> {
    if (!this.config.endpoint) {
      throw new Error('Ollama endpoint not configured');
    }

    try {
      const data = await withRetry(async () => {
        const response = await fetchWithTimeout(
          `${this.config.endpoint}/api/generate`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: this.config.model,
              prompt: `Translate this natural language instruction into browser automation actions: "${request.instruction}"

Available actions: click, fill, navigate
Respond with JSON: {"actions": [...], "confidence": 0.8, "reasoning": "..."}`,
              stream: false,
            }),
          },
          this.config.timeout ?? DEFAULT_TIMEOUT_MS,
        );

        if (!response.ok) {
          // Attach status so withRetry can distinguish transient 5xx/429 from 4xx.
          throw Object.assign(new Error(`Ollama request failed: ${response.status}`), {
            status: response.status,
          });
        }

        return response.json();
      }, this.config.retryConfig ?? DEFAULT_RETRY_CONFIG);

      const parsed = JSON.parse(data.response);

      return {
        actions: parsed.actions || [],
        confidence: parsed.confidence || 0.5,
        reasoning: parsed.reasoning,
      };
    } catch (error) {
      console.error('Ollama translation error:', formatError(error));
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
