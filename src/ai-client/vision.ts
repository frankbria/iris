import { IrisConfig } from '../config';
import {
  BaseAIVisionClient,
  AITranslationRequest,
  AITranslationResponse,
  AIVisionRequest,
  AIVisionResponse,
} from './base';
import { withRetry, fetchWithTimeout, DEFAULT_TIMEOUT_MS, DEFAULT_RETRY_CONFIG } from './retry';
import { AIVisionResponseSchema } from './types';

/**
 * Appended to the user prompt when a diff mask travels with the screenshots.
 *
 * Shared across providers so the wording can only drift deliberately. Nothing
 * is appended when there is no diff, which keeps the two-image prompt (and so
 * every existing provider payload) byte-identical. See issue #124.
 *
 * Carries no surrounding whitespace: each provider's template sits at a
 * different place in its prompt, so the separator belongs to the call site.
 * Baking one in here meant one provider had to strip it back off, and any later
 * edit to this string would have silently reformatted that provider's prompt.
 */
const DIFF_IMAGE_PROMPT =
  'The third image highlights the changed regions (diff mask) — use it to localize what changed.';

/**
 * Identify an image's MIME type from its magic bytes.
 *
 * These call sites used to hardcode `image/png` while the default preprocessor
 * encodes JPEG, so every screenshot went out mislabelled (issue #162).
 * Anthropic validates `media_type` against the actual bytes and rejects a
 * mismatch; because that rejection happens inside `analyzeVisualDiff`'s
 * try/catch, `SmartAIVisionClient` just moved to the next provider and the user
 * saw a generic "all providers failed" instead of the real cause.
 *
 * Sniffing the buffer rather than threading a format flag down from the
 * preprocessor is deliberate: the bytes are the single source of truth, so the
 * label cannot drift from them no matter who builds the request or with which
 * `PreprocessorConfig`. It also stays correct for direct library callers, who
 * pass their own buffers and never touch the preprocessor. It matters per-image
 * rather than per-request because the shipped pipeline mixes formats — JPEG
 * screenshots alongside a PNG diff mask (#124).
 *
 * Falls back to `image/png` for anything unrecognised: a wrong-but-plausible
 * label beats turning an analysis into an error, and PNG is what this code
 * claimed for years.
 */
function detectImageMimeType(buffer: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return 'image/png';
  }
  // RIFF....WEBP — the four-byte size field sits between the two markers.
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return 'image/png';
}

/**
 * OpenAI GPT-4V/GPT-4o vision client for visual diff analysis
 */
export class OpenAIVisionClient extends BaseAIVisionClient {
  constructor(config: IrisConfig['ai']) {
    super(config);
  }

  async translateInstruction(_request: AITranslationRequest): Promise<AITranslationResponse> {
    // For now, delegate to text-only implementation
    // Vision-enhanced translation will be added in future iteration
    throw new Error('Vision-enhanced translation not yet implemented');
  }

  async analyzeVisualDiff(request: AIVisionRequest): Promise<AIVisionResponse> {
    if (!this.config.apiKey) {
      throw new Error('OpenAI API key not configured');
    }

    try {
      const { OpenAI } = await import('openai');
      const openai = new OpenAI({
        apiKey: this.config.apiKey,
        timeout: this.config.timeout ?? DEFAULT_TIMEOUT_MS,
        maxRetries: 0, // retries are driven by our withRetry below
      });

      // Convert buffers to base64
      const baselineBase64 = request.baseline.toString('base64');
      const currentBase64 = request.current.toString('base64');
      const diffBase64 = request.diff?.toString('base64');
      // Per image: the shipped pipeline mixes JPEG screenshots with a PNG diff
      // mask, so a single per-request type would have to be wrong for one.
      const baselineType = detectImageMimeType(request.baseline);
      const currentType = detectImageMimeType(request.current);
      const diffType = request.diff ? detectImageMimeType(request.diff) : undefined;

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

Compare the baseline (first image) with the current (second image) and identify any visual regressions.${diffBase64 ? `\n\n${DIFF_IMAGE_PROMPT}` : ''}`;

      const response = await withRetry(
        () =>
          openai.chat.completions.create({
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
                      url: `data:${baselineType};base64,${baselineBase64}`,
                      detail: 'high',
                    },
                  },
                  {
                    type: 'image_url',
                    image_url: {
                      url: `data:${currentType};base64,${currentBase64}`,
                      detail: 'high',
                    },
                  },
                  ...(diffBase64
                    ? [
                        {
                          type: 'image_url' as const,
                          image_url: {
                            url: `data:${diffType};base64,${diffBase64}`,
                            detail: 'high' as const,
                          },
                        },
                      ]
                    : []),
                ],
              },
            ],
            temperature: 0.1,
            max_tokens: 1000,
          }),
        this.config.retryConfig ?? DEFAULT_RETRY_CONFIG,
      );

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('No response from OpenAI vision API');
      }

      // Validate before use: invalid/empty severity throws (surfacing through
      // handleVisionError) rather than silently degrading to severity:'none'.
      const parsed = AIVisionResponseSchema.parse(JSON.parse(content));

      // Attach token usage (defensive: may be absent) so downstream cost
      // tracking reflects real high-detail token consumption, not a flat rate.
      const usage = response.usage
        ? {
            inputTokens: response.usage.prompt_tokens ?? 0,
            outputTokens: response.usage.completion_tokens ?? 0,
            totalTokens: response.usage.total_tokens,
          }
        : undefined;

      return usage ? { ...parsed, usage } : parsed;
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

  async translateInstruction(_request: AITranslationRequest): Promise<AITranslationResponse> {
    // Stub implementation - vision-enhanced translation future feature
    throw new Error('Anthropic vision translation not yet implemented');
  }

  async analyzeVisualDiff(request: AIVisionRequest): Promise<AIVisionResponse> {
    if (!this.config.apiKey) {
      throw new Error('Anthropic API key not configured');
    }

    try {
      const { Anthropic } = await import('@anthropic-ai/sdk');
      const anthropic = new Anthropic({
        apiKey: this.config.apiKey,
        timeout: this.config.timeout ?? DEFAULT_TIMEOUT_MS,
        maxRetries: 0, // retries are driven by our withRetry below
      });

      // Convert buffers to base64
      const baselineBase64 = request.baseline.toString('base64');
      const currentBase64 = request.current.toString('base64');
      const diffBase64 = request.diff?.toString('base64');
      // Per image: the shipped pipeline mixes JPEG screenshots with a PNG diff
      // mask, so a single per-request type would have to be wrong for one.
      const baselineType = detectImageMimeType(request.baseline);
      const currentType = detectImageMimeType(request.current);
      const diffType = request.diff ? detectImageMimeType(request.diff) : undefined;

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

Compare the baseline (first image) with the current (second image).${diffBase64 ? `\n\n${DIFF_IMAGE_PROMPT}` : ''}

Respond with JSON:
{
  "severity": "none" | "minor" | "moderate" | "breaking",
  "confidence": number,
  "reasoning": string,
  "categories": string[],
  "suggestions": string[]
}`;

      const response = await withRetry(
        () =>
          anthropic.messages.create({
            model: this.config.model || 'claude-sonnet-5',
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
                      media_type: baselineType,
                      data: baselineBase64,
                    },
                  },
                  {
                    type: 'image',
                    source: {
                      type: 'base64',
                      media_type: currentType,
                      data: currentBase64,
                    },
                  },
                  ...(diffBase64
                    ? [
                        {
                          type: 'image' as const,
                          source: {
                            type: 'base64' as const,
                            media_type: diffType!,
                            data: diffBase64,
                          },
                        },
                      ]
                    : []),
                ],
              },
            ],
          }),
        this.config.retryConfig ?? DEFAULT_RETRY_CONFIG,
      );

      const content = response.content[0];
      if (content.type !== 'text') {
        throw new Error('Unexpected response type from Anthropic');
      }

      // Validate before use (see OpenAI path): invalid severity throws.
      const parsed = AIVisionResponseSchema.parse(JSON.parse(content.text));

      // Attach token usage (defensive: may be absent) for real cost accounting.
      const usage = response.usage
        ? {
            inputTokens: response.usage.input_tokens ?? 0,
            outputTokens: response.usage.output_tokens ?? 0,
          }
        : undefined;

      return usage ? { ...parsed, usage } : parsed;
    } catch (error) {
      return this.handleVisionError(error, 'Anthropic vision analysis');
    }
  }

  async isAvailable(): Promise<boolean> {
    return !!this.config.apiKey && this.supportsVision();
  }

  // No `supportsVision()` override on purpose (issue #183). This used to be
  // `model.includes('claude-3')` — a capability check written as a substring
  // test, so it inverted as soon as the claude-3 family was retired: true for
  // everything Anthropic served in 2024, false for everything it serves now.
  // Since `isAvailable()` gates on it, that silently dropped this client from
  // the fallback chain, and a *correctly* configured current model failed the
  // test just as hard as a stale one. Every model in the current lineup is
  // multimodal, so the base class's unconditional `true` is the honest answer;
  // an unreachable model is the request's problem to report, not this method's
  // to guess at. Don't reintroduce a name match here.
}

/**
 * Ollama local vision client (llava, bakllava models)
 */
export class OllamaVisionClient extends BaseAIVisionClient {
  constructor(config: IrisConfig['ai']) {
    super(config);
  }

  async translateInstruction(_request: AITranslationRequest): Promise<AITranslationResponse> {
    // Stub implementation - vision-enhanced translation future feature
    throw new Error('Ollama vision translation not yet implemented');
  }

  async analyzeVisualDiff(request: AIVisionRequest): Promise<AIVisionResponse> {
    if (!this.config.endpoint) {
      throw new Error('Ollama endpoint not configured');
    }

    try {
      // Convert buffers to base64
      const baselineBase64 = request.baseline.toString('base64');
      const currentBase64 = request.current.toString('base64');
      const diffBase64 = request.diff?.toString('base64');

      const prompt = `You are an expert at analyzing visual differences in web UIs for regression testing.

Compare these two screenshots (baseline vs current) and classify the visual differences.

Severity levels:
- "none": No meaningful differences
- "minor": Small changes not affecting functionality
- "moderate": Noticeable changes needing review
- "breaking": Major changes likely indicating bugs

Categories: layout, text, color, spacing, content
${diffBase64 ? DIFF_IMAGE_PROMPT : ''}
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

      const data = await withRetry(async () => {
        const response = await fetchWithTimeout(
          `${this.config.endpoint}/api/generate`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: this.config.model || 'llava',
              prompt,
              images: diffBase64
                ? [baselineBase64, currentBase64, diffBase64]
                : [baselineBase64, currentBase64],
              stream: false,
              options: {
                temperature: 0.1,
              },
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

      // Validate before use (see OpenAI path): invalid severity throws.
      const parsed = AIVisionResponseSchema.parse(JSON.parse(data.response));

      // Ollama reports token counts via prompt_eval_count/eval_count when
      // present. If absent, leave usage undefined — the cost tracker falls back
      // to the flat per-image price (Ollama pricing is zero anyway).
      const usage =
        data.prompt_eval_count != null || data.eval_count != null
          ? {
              inputTokens: data.prompt_eval_count ?? 0,
              outputTokens: data.eval_count ?? 0,
            }
          : undefined;

      return usage ? { ...parsed, usage } : parsed;
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
        (m: { name: string }) => m.name.includes('llava') || m.name.includes('bakllava'),
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
