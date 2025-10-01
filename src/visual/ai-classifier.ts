import sharp from 'sharp';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { AIVisualAnalysis } from './types';

/**
 * AI Provider Types
 */
export type AIProvider = 'openai' | 'claude' | 'ollama';

export interface AIProviderConfig {
  provider: AIProvider;
  apiKey?: string;
  model?: string;
  baseURL?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface PreparedImageForAI {
  base64: string;
  mimeType: string;
  width: number;
  height: number;
}

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
 * Integrates with OpenAI GPT-4V, Claude 3.5 Sonnet, and Ollama for
 * intelligent classification of visual changes as intentional or unintentional.
 */
export class AIVisualClassifier {
  private openaiClient?: OpenAI;
  private anthropicClient?: Anthropic;
  private config: AIProviderConfig;

  constructor(config: AIProviderConfig) {
    this.config = {
      maxTokens: 2048,
      temperature: 0.1,
      ...config,
    };

    // Initialize provider clients based on config
    this.initializeProviders();
  }

  /**
   * Initialize AI provider clients based on configuration
   */
  private initializeProviders(): void {
    switch (this.config.provider) {
      case 'openai':
        if (!this.config.apiKey) {
          throw new Error('OpenAI API key is required for provider "openai"');
        }
        this.openaiClient = new OpenAI({
          apiKey: this.config.apiKey,
        });
        // Default to GPT-4V if no model specified
        this.config.model = this.config.model || 'gpt-4-vision-preview';
        break;

      case 'claude':
        if (!this.config.apiKey) {
          throw new Error('Anthropic API key is required for provider "claude"');
        }
        this.anthropicClient = new Anthropic({
          apiKey: this.config.apiKey,
        });
        // Default to Claude 3.5 Sonnet if no model specified
        this.config.model = this.config.model || 'claude-3-5-sonnet-20241022';
        break;

      case 'ollama':
        // Ollama runs locally, use baseURL or default to localhost
        this.config.baseURL = this.config.baseURL || 'http://localhost:11434';
        this.config.model = this.config.model || 'llava:latest';
        break;

      default:
        throw new Error(`Unsupported AI provider: ${this.config.provider}`);
    }
  }

  /**
   * Prepare image for AI analysis by converting to base64 and optimizing size
   */
  async prepareImageForAI(imageBuffer: Buffer, maxWidth: number = 1024): Promise<PreparedImageForAI> {
    try {
      const image = sharp(imageBuffer);
      const metadata = await image.metadata();

      // Resize if larger than max width while maintaining aspect ratio
      let processedImage = image;
      if (metadata.width && metadata.width > maxWidth) {
        processedImage = image.resize(maxWidth, undefined, {
          fit: 'inside',
          withoutEnlargement: true,
        });
      }

      // Convert to JPEG for better compression (AI models handle JPEG well)
      const optimizedBuffer = await processedImage
        .jpeg({ quality: 85 })
        .toBuffer();

      const base64 = optimizedBuffer.toString('base64');
      const finalMetadata = await sharp(optimizedBuffer).metadata();

      return {
        base64,
        mimeType: 'image/jpeg',
        width: finalMetadata.width || 0,
        height: finalMetadata.height || 0,
      };
    } catch (error) {
      throw new Error(`Failed to prepare image for AI: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Prepare multiple images for batch AI analysis
   */
  async prepareImagesForAI(images: Buffer[], maxWidth: number = 1024): Promise<PreparedImageForAI[]> {
    return Promise.all(images.map(img => this.prepareImageForAI(img, maxWidth)));
  }

  /**
   * Analyze visual changes using the configured AI provider
   */
  async analyzeChange(request: AIAnalysisRequest): Promise<AIAnalysisResponse> {
    // Prepare images for AI consumption
    const [baseline, current, diff] = await this.prepareImagesForAI(
      [request.baselineImage, request.currentImage, ...(request.diffImage ? [request.diffImage] : [])]
    );

    // Route to appropriate provider
    switch (this.config.provider) {
      case 'openai':
        return this.analyzeWithOpenAI(baseline, current, diff, request.context);
      case 'claude':
        return this.analyzeWithClaude(baseline, current, diff, request.context);
      case 'ollama':
        return this.analyzeWithOllama(baseline, current, diff, request.context);
      default:
        throw new Error(`Unsupported provider: ${this.config.provider}`);
    }
  }

  /**
   * Batch analyze multiple visual changes
   */
  async batchAnalyze(requests: AIAnalysisRequest[]): Promise<AIAnalysisResponse[]> {
    // Process in parallel with concurrency limit to avoid rate limits
    const results: AIAnalysisResponse[] = [];
    const concurrency = 3; // Conservative limit for API rate limits

    for (let i = 0; i < requests.length; i += concurrency) {
      const batch = requests.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map(req => this.analyzeChange(req))
      );
      results.push(...batchResults);
    }

    return results;
  }

  /**
   * Analyze using OpenAI GPT-4V
   */
  private async analyzeWithOpenAI(
    baseline: PreparedImageForAI,
    current: PreparedImageForAI,
    diff: PreparedImageForAI | undefined,
    context?: AIAnalysisRequest['context']
  ): Promise<AIAnalysisResponse> {
    if (!this.openaiClient) {
      throw new Error('OpenAI client not initialized');
    }

    const prompt = this.buildAnalysisPrompt(context);

    try {
      const messageContent: any[] = [
        { type: 'text', text: prompt },
        {
          type: 'image_url',
          image_url: {
            url: `data:${baseline.mimeType};base64,${baseline.base64}`,
            detail: 'high',
          },
        },
        {
          type: 'image_url',
          image_url: {
            url: `data:${current.mimeType};base64,${current.base64}`,
            detail: 'high',
          },
        },
      ];

      if (diff) {
        messageContent.push({
          type: 'image_url',
          image_url: {
            url: `data:${diff.mimeType};base64,${diff.base64}`,
            detail: 'high',
          },
        });
      }

      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        {
          role: 'user',
          content: messageContent,
        },
      ];

      const response = await this.openaiClient.chat.completions.create({
        model: this.config.model!,
        messages,
        max_tokens: this.config.maxTokens,
        temperature: this.config.temperature,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('No response from OpenAI');
      }

      return this.parseAIResponse(content);
    } catch (error) {
      throw new Error(`OpenAI analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Analyze using Anthropic Claude
   */
  private async analyzeWithClaude(
    baseline: PreparedImageForAI,
    current: PreparedImageForAI,
    diff: PreparedImageForAI | undefined,
    context?: AIAnalysisRequest['context']
  ): Promise<AIAnalysisResponse> {
    if (!this.anthropicClient) {
      throw new Error('Anthropic client not initialized');
    }

    const prompt = this.buildAnalysisPrompt(context);

    try {
      const imageContent: any[] = [
        { type: 'text', text: 'Baseline Image:' },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: baseline.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
            data: baseline.base64,
          },
        },
        { type: 'text', text: 'Current Image:' },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: current.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
            data: current.base64,
          },
        },
      ];

      if (diff) {
        imageContent.push(
          { type: 'text', text: 'Diff Visualization:' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: diff.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              data: diff.base64,
            },
          }
        );
      }

      imageContent.push({ type: 'text', text: prompt });

      const response = await this.anthropicClient.messages.create({
        model: this.config.model!,
        max_tokens: this.config.maxTokens!,
        temperature: this.config.temperature!,
        messages: [
          {
            role: 'user',
            content: imageContent,
          },
        ],
      });

      const textBlock = response.content.find(block => block.type === 'text');
      if (!textBlock || textBlock.type !== 'text') {
        throw new Error('No text response from Claude');
      }

      return this.parseAIResponse(textBlock.text);
    } catch (error) {
      throw new Error(`Claude analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Analyze using Ollama (local model)
   */
  private async analyzeWithOllama(
    baseline: PreparedImageForAI,
    current: PreparedImageForAI,
    diff: PreparedImageForAI | undefined,
    context?: AIAnalysisRequest['context']
  ): Promise<AIAnalysisResponse> {
    const prompt = this.buildAnalysisPrompt(context);

    try {
      // Ollama uses a simple REST API
      const response = await fetch(`${this.config.baseURL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.config.model,
          prompt,
          images: [baseline.base64, current.base64, ...(diff ? [diff.base64] : [])],
          stream: false,
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama request failed: ${response.statusText}`);
      }

      const data = await response.json();
      return this.parseAIResponse(data.response);
    } catch (error) {
      throw new Error(`Ollama analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Build analysis prompt with context injection
   */
  private buildAnalysisPrompt(context?: AIAnalysisRequest['context']): string {
    const contextInfo = context ? `
Test Context:
- Test Name: ${context.testName || 'Unknown'}
- URL: ${context.url || 'Unknown'}
- Viewport: ${context.viewport ? `${context.viewport.width}x${context.viewport.height}` : 'Unknown'}
- Git Branch: ${context.gitBranch || 'Unknown'}
` : '';

    return `You are an expert visual regression testing analyst. Compare the baseline and current screenshots to determine if the visual changes are intentional or represent regressions.

${contextInfo}

Analyze the images and provide a structured response in JSON format with the following fields:

{
  "classification": "intentional" | "regression" | "unknown",
  "confidence": 0.0-1.0 (confidence score),
  "description": "Detailed description of changes observed",
  "severity": "low" | "medium" | "high" | "critical",
  "suggestions": ["array", "of", "specific", "recommendations"],
  "isIntentional": true | false,
  "changeType": "layout" | "color" | "content" | "typography" | "animation" | "unknown",
  "reasoning": "Explanation of why this is classified as intentional/regression",
  "regions": [
    {
      "x": number,
      "y": number,
      "width": number,
      "height": number,
      "type": "header" | "nav" | "content" | "footer" | "sidebar" | "other",
      "description": "Description of change in this region"
    }
  ]
}

Focus on:
1. Layout shifts and positioning changes
2. Color and styling differences
3. Content additions/removals/modifications
4. Typography changes (fonts, sizes, weights)
5. Animation or interactive element changes
6. Accessibility implications

Provide specific, actionable insights. If changes appear to be bugs (misalignment, broken layouts, missing content), classify as "regression" with high severity. If changes appear deliberate (new features, intentional redesign), classify as "intentional" with appropriate severity based on impact.

Return ONLY the JSON object, no additional text.`;
  }

  /**
   * Parse and validate AI response into structured format
   */
  private parseAIResponse(response: string): AIAnalysisResponse {
    try {
      // Extract JSON from response (handles cases where AI adds extra text)
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in AI response');
      }

      const parsed = JSON.parse(jsonMatch[0]);

      // Validate and normalize the response
      return {
        classification: parsed.classification || 'unknown',
        confidence: this.normalizeConfidence(parsed.confidence),
        description: parsed.description || 'No description provided',
        severity: this.validateSeverity(parsed.severity),
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
        isIntentional: parsed.isIntentional ?? (parsed.classification === 'intentional'),
        changeType: this.validateChangeType(parsed.changeType),
        reasoning: parsed.reasoning || 'No reasoning provided',
        regions: Array.isArray(parsed.regions) ? parsed.regions : undefined,
      };
    } catch (error) {
      // Fallback response if parsing fails
      return {
        classification: 'unknown',
        confidence: 0.5,
        description: `Failed to parse AI response: ${error instanceof Error ? error.message : 'Unknown error'}`,
        severity: 'medium',
        suggestions: ['Review the visual changes manually', 'Check AI provider configuration'],
        isIntentional: false,
        changeType: 'unknown',
        reasoning: 'AI response could not be parsed',
      };
    }
  }

  /**
   * Normalize confidence score to 0-1 range
   */
  private normalizeConfidence(value: any): number {
    const num = Number(value);
    if (isNaN(num)) return 0.5;
    return Math.max(0, Math.min(1, num));
  }

  /**
   * Validate severity level
   */
  private validateSeverity(value: any): 'low' | 'medium' | 'high' | 'critical' {
    const validSeverities = ['low', 'medium', 'high', 'critical'];
    return validSeverities.includes(value) ? value : 'medium';
  }

  /**
   * Validate change type
   */
  private validateChangeType(value: any): 'layout' | 'color' | 'content' | 'typography' | 'animation' | 'unknown' {
    const validTypes = ['layout', 'color', 'content', 'typography', 'animation', 'unknown'];
    return validTypes.includes(value) ? value : 'unknown';
  }

  /**
   * Convert analysis response to AIVisualAnalysis format for compatibility
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
}
