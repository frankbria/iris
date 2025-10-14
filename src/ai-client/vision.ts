import { IrisConfig } from '../config';
import {
  BaseAIVisionClient,
  AITranslationRequest,
  AITranslationResponse,
  AIVisionRequest,
  AIVisionResponse,
} from './base';

/**
 * OpenAI GPT-4V/GPT-4o vision client for visual diff analysis
 */
export class OpenAIVisionClient extends BaseAIVisionClient {
  constructor(config: IrisConfig['ai']) {
    super(config);
  }

  async translateInstruction(
    request: AITranslationRequest
  ): Promise<AITranslationResponse> {
    // For now, delegate to text-only implementation
    // Vision-enhanced translation will be added in future iteration
    throw new Error('Vision-enhanced translation not yet implemented');
  }

  async analyzeVisualDiff(
    request: AIVisionRequest
  ): Promise<AIVisionResponse> {
    if (!this.config.apiKey) {
      throw new Error('OpenAI API key not configured');
    }

    try {
      const { OpenAI } = await import('openai');
      const openai = new OpenAI({ apiKey: this.config.apiKey });

      // Convert buffers to base64
      const baselineBase64 = request.baseline.toString('base64');
      const currentBase64 = request.current.toString('base64');

      const systemPrompt = `You are an expert at analyzing visual differences in web UIs for regression testing.

Your task is to classify visual changes between a baseline screenshot and a current screenshot.

Classify the severity as:
- "none": No meaningful visual differences
- "minor": Small changes that don't affect functionality (slight color shifts, minor spacing)
- "moderate": Noticeable changes that might need review (text changes, layout shifts)
- "breaking": Major changes that likely indicate bugs (missing elements, broken layouts, wrong colors)

Identify affected categories:
- "layout": Element positioning or sizing changes
- "text": Text content or typography changes
- "color": Color or styling changes
- "spacing": Margin, padding, or gap changes
- "content": Missing or added elements

Provide a confidence score (0-1) indicating your certainty in the classification.

Respond with valid JSON matching this schema:
{
  "severity": "none" | "minor" | "moderate" | "breaking",
  "confidence": number (0-1),
  "reasoning": string (clear explanation of what changed and why it matters),
  "categories": string[] (affected categories),
  "suggestions": string[] (optional recommendations)
}`;

      const userPrompt = `Analyze these two screenshots and classify the visual differences.

${
  request.context
    ? `Context:
- URL: ${request.context.url || 'unknown'}
- Element: ${request.context.selector || 'full page'}
${
  request.context.previousClassifications
    ? `- Previous classifications: ${JSON.stringify(request.context.previousClassifications.slice(0, 3))}`
    : ''
}`
    : ''
}

Compare the baseline (first image) with the current (second image) and identify any visual regressions.`;

      const response = await openai.chat.completions.create({
        model: this.config.model || 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: [
              { type: 'text', text: userPrompt },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/png;base64,${baselineBase64}`,
                  detail: 'high',
                },
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/png;base64,${currentBase64}`,
                  detail: 'high',
                },
              },
            ],
          },
        ],
        temperature: 0.1,
        max_tokens: 1000,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('No response from OpenAI vision API');
      }

      const parsed = JSON.parse(content);
      return {
        severity: parsed.severity || 'none',
        confidence: parsed.confidence || 0.5,
        reasoning: parsed.reasoning || 'No reasoning provided',
        categories: parsed.categories || [],
        suggestions: parsed.suggestions,
      };
    } catch (error) {
      return this.handleVisionError(error, 'OpenAI vision analysis');
    }
  }

  async isAvailable(): Promise<boolean> {
    return !!this.config.apiKey && this.supportsVision();
  }

  supportsVision(): boolean {
    // GPT-4V and GPT-4o support vision
    const model = this.config.model || '';
    return model.includes('gpt-4') || model.includes('gpt-4o');
  }
}

/**
 * Anthropic Claude 3.5 Sonnet vision client for visual diff analysis
 */
export class AnthropicVisionClient extends BaseAIVisionClient {
  constructor(config: IrisConfig['ai']) {
    super(config);
  }

  async translateInstruction(
    request: AITranslationRequest
  ): Promise<AITranslationResponse> {
    // Stub implementation - vision-enhanced translation future feature
    throw new Error('Anthropic vision translation not yet implemented');
  }

  async analyzeVisualDiff(
    request: AIVisionRequest
  ): Promise<AIVisionResponse> {
    if (!this.config.apiKey) {
      throw new Error('Anthropic API key not configured');
    }

    try {
      const { Anthropic } = await import('@anthropic-ai/sdk');
      const anthropic = new Anthropic({ apiKey: this.config.apiKey });

      // Convert buffers to base64
      const baselineBase64 = request.baseline.toString('base64');
      const currentBase64 = request.current.toString('base64');

      const systemPrompt = `You are an expert at analyzing visual differences in web UIs for regression testing.

Classify visual changes between baseline and current screenshots into severity levels:
- "none": No meaningful visual differences
- "minor": Small changes not affecting functionality (slight color shifts, minor spacing)
- "moderate": Noticeable changes needing review (text changes, layout shifts)
- "breaking": Major changes likely indicating bugs (missing elements, broken layouts)

Identify affected categories: layout, text, color, spacing, content

Provide confidence score (0-1) and clear reasoning with optional suggestions.`;

      const userMessage = `Analyze these two screenshots and classify the visual differences.

${
  request.context
    ? `Context:
- URL: ${request.context.url || 'unknown'}
- Element: ${request.context.selector || 'full page'}`
    : ''
}

Compare the baseline (first image) with the current (second image).

Respond with JSON:
{
  "severity": "none" | "minor" | "moderate" | "breaking",
  "confidence": number,
  "reasoning": string,
  "categories": string[],
  "suggestions": string[]
}`;

      const response = await anthropic.messages.create({
        model: this.config.model || 'claude-3-5-sonnet-20241022',
        max_tokens: 1000,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: systemPrompt },
              { type: 'text', text: userMessage },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: baselineBase64,
                },
              },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: currentBase64,
                },
              },
            ],
          },
        ],
      });

      const content = response.content[0];
      if (content.type !== 'text') {
        throw new Error('Unexpected response type from Anthropic');
      }

      const parsed = JSON.parse(content.text);
      return {
        severity: parsed.severity || 'none',
        confidence: parsed.confidence || 0.5,
        reasoning: parsed.reasoning || 'No reasoning provided',
        categories: parsed.categories || [],
        suggestions: parsed.suggestions,
      };
    } catch (error) {
      return this.handleVisionError(error, 'Anthropic vision analysis');
    }
  }

  async isAvailable(): Promise<boolean> {
    return !!this.config.apiKey && this.supportsVision();
  }

  supportsVision(): boolean {
    // Claude 3.5 Sonnet supports vision
    const model = this.config.model || '';
    return model.includes('claude-3');
  }
}

/**
 * Ollama local vision client (llava, bakllava models)
 */
export class OllamaVisionClient extends BaseAIVisionClient {
  constructor(config: IrisConfig['ai']) {
    super(config);
  }

  async translateInstruction(
    request: AITranslationRequest
  ): Promise<AITranslationResponse> {
    // Stub implementation - vision-enhanced translation future feature
    throw new Error('Ollama vision translation not yet implemented');
  }

  async analyzeVisualDiff(
    request: AIVisionRequest
  ): Promise<AIVisionResponse> {
    if (!this.config.endpoint) {
      throw new Error('Ollama endpoint not configured');
    }

    try {
      // Convert buffers to base64
      const baselineBase64 = request.baseline.toString('base64');
      const currentBase64 = request.current.toString('base64');

      const prompt = `You are an expert at analyzing visual differences in web UIs for regression testing.

Compare these two screenshots (baseline vs current) and classify the visual differences.

Severity levels:
- "none": No meaningful differences
- "minor": Small changes not affecting functionality
- "moderate": Noticeable changes needing review
- "breaking": Major changes likely indicating bugs

Categories: layout, text, color, spacing, content

${
  request.context
    ? `Context:
- URL: ${request.context.url || 'unknown'}
- Element: ${request.context.selector || 'full page'}`
    : ''
}

Respond with JSON only:
{
  "severity": "none"|"minor"|"moderate"|"breaking",
  "confidence": 0.8,
  "reasoning": "description of changes",
  "categories": ["layout", "text"],
  "suggestions": ["optional recommendations"]
}`;

      const response = await fetch(`${this.config.endpoint}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.config.model || 'llava',
          prompt,
          images: [baselineBase64, currentBase64],
          stream: false,
          options: {
            temperature: 0.1,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama request failed: ${response.status}`);
      }

      const data = await response.json();
      const parsed = JSON.parse(data.response);

      return {
        severity: parsed.severity || 'none',
        confidence: parsed.confidence || 0.5,
        reasoning: parsed.reasoning || 'No reasoning provided',
        categories: parsed.categories || [],
        suggestions: parsed.suggestions,
      };
    } catch (error) {
      return this.handleVisionError(error, 'Ollama vision analysis');
    }
  }

  async isAvailable(): Promise<boolean> {
    if (!this.config.endpoint) return false;

    // Check if Ollama is running and has vision-capable model
    try {
      const response = await fetch(`${this.config.endpoint}/api/tags`);
      if (!response.ok) return false;

      const data = await response.json();
      return data.models?.some(
        (m: { name: string }) =>
          m.name.includes('llava') || m.name.includes('bakllava')
      );
    } catch {
      return false;
    }
  }

  supportsVision(): boolean {
    // llava and bakllava are vision models
    const model = this.config.model || '';
    return model.includes('llava') || model.includes('bakllava');
  }
}
