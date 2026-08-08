/**
 * Tests for the vision provider clients (src/ai-client/vision.ts).
 *
 * These success/parse paths had zero coverage (issue #62 / P0.9): the SDK
 * request payload, the JSON response parsing, and the missing-key / bad-response
 * error paths were never exercised. SDK boundaries are mocked; everything else
 * is the real client.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { IrisConfig } from '../src/config';
import {
  OpenAIVisionClient,
  AnthropicVisionClient,
  OllamaVisionClient,
} from '../src/ai-client/vision';

// --- OpenAI SDK mock ---
const mockOpenAICreate = jest.fn();
jest.mock('openai', () => ({
  OpenAI: jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockOpenAICreate } },
  })),
}));

// --- Anthropic SDK mock ---
const mockAnthropicCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => ({
  Anthropic: jest.fn().mockImplementation(() => ({
    messages: { create: mockAnthropicCreate },
  })),
}));

const baseline = Buffer.from('baseline-bytes');
const current = Buffer.from('current-bytes');
const diff = Buffer.from('diff-bytes');
const request = { baseline, current, context: { url: 'https://example.com' } };
// Issue #124: same request plus the computed diff mask as a third image.
const requestWithDiff = { ...request, diff };

const parsed = {
  severity: 'moderate',
  confidence: 0.9,
  reasoning: 'Header moved down',
  categories: ['layout'],
  suggestions: ['Check flexbox'],
};

/**
 * Real encoded bytes, so the declared MIME type is checked against what an
 * actual encoder produces rather than against a hand-written magic-number
 * fixture that could be wrong in the same direction as the code (issue #162).
 */
const encode = async (format: 'jpeg' | 'png' | 'webp'): Promise<Buffer> => {
  const sharp = (await import('sharp')).default;
  const pipeline = sharp({
    create: { width: 8, height: 8, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } },
  });
  if (format === 'jpeg') return pipeline.jpeg().toBuffer();
  if (format === 'png') return pipeline.png().toBuffer();
  return pipeline.webp().toBuffer();
};

describe('vision clients', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('OpenAIVisionClient', () => {
    const config: IrisConfig['ai'] = { provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o' };

    it('throws when the apiKey is missing', async () => {
      const client = new OpenAIVisionClient({ provider: 'openai', model: 'gpt-4o' });
      await expect(client.analyzeVisualDiff(request)).rejects.toThrow(/OpenAI API key/i);
    });

    it('sends the configured model + both images and parses the JSON response', async () => {
      mockOpenAICreate.mockResolvedValue({
        choices: [{ message: { content: JSON.stringify(parsed) } }],
      });

      const client = new OpenAIVisionClient(config);
      const result = await client.analyzeVisualDiff(request);

      expect(result).toEqual({
        severity: 'moderate',
        confidence: 0.9,
        reasoning: 'Header moved down',
        categories: ['layout'],
        suggestions: ['Check flexbox'],
      });

      const payload = mockOpenAICreate.mock.calls[0][0];
      expect(payload.model).toBe('gpt-4o');
      const userContent = payload.messages.find((m: { role: string }) => m.role === 'user').content;
      const imageParts = userContent.filter((p: { type: string }) => p.type === 'image_url');
      expect(imageParts).toHaveLength(2);
      expect(imageParts[0].image_url.url).toContain(baseline.toString('base64'));
      expect(imageParts[1].image_url.url).toContain(current.toString('base64'));
    });

    it('appends the diff mask as a third image and points the prompt at it (issue #124)', async () => {
      mockOpenAICreate.mockResolvedValue({
        choices: [{ message: { content: JSON.stringify(parsed) } }],
      });

      await new OpenAIVisionClient(config).analyzeVisualDiff(requestWithDiff);

      const payload = mockOpenAICreate.mock.calls[0][0];
      const userContent = payload.messages.find((m: { role: string }) => m.role === 'user').content;
      const imageParts = userContent.filter((p: { type: string }) => p.type === 'image_url');
      expect(imageParts).toHaveLength(3);
      // Order matters: the prompt describes first/second/third positionally.
      expect(imageParts[0].image_url.url).toContain(baseline.toString('base64'));
      expect(imageParts[1].image_url.url).toContain(current.toString('base64'));
      expect(imageParts[2].image_url.url).toContain(diff.toString('base64'));

      const text = userContent.find((p: { type: string }) => p.type === 'text').text;
      expect(text).toMatch(/third image/i);
    });

    it('leaves the two-image prompt untouched when no diff is supplied (issue #124)', async () => {
      mockOpenAICreate.mockResolvedValue({
        choices: [{ message: { content: JSON.stringify(parsed) } }],
      });

      await new OpenAIVisionClient(config).analyzeVisualDiff(request);

      const userContent = mockOpenAICreate.mock.calls[0][0].messages.find(
        (m: { role: string }) => m.role === 'user',
      ).content;
      const text = userContent.find((p: { type: string }) => p.type === 'text').text;
      expect(text).not.toMatch(/third image/i);
    });

    it('throws when the model omits severity instead of defaulting to none (issue #66)', async () => {
      // severity is a data-integrity signal: an absent/invalid value must fail
      // validation rather than silently degrade to a clean severity:'none'.
      mockOpenAICreate.mockResolvedValue({
        choices: [{ message: { content: JSON.stringify({ reasoning: 'x' }) } }],
      });

      const client = new OpenAIVisionClient(config);
      await expect(client.analyzeVisualDiff(request)).rejects.toThrow();
    });

    it('applies defaults for soft fields the model omits (severity present)', async () => {
      mockOpenAICreate.mockResolvedValue({
        choices: [{ message: { content: JSON.stringify({ severity: 'minor' }) } }],
      });

      const client = new OpenAIVisionClient(config);
      const result = await client.analyzeVisualDiff(request);

      expect(result.severity).toBe('minor');
      expect(result.confidence).toBe(0.5);
      expect(result.categories).toEqual([]);
    });

    it('maps SDK usage into normalized inputTokens/outputTokens (issue #67)', async () => {
      mockOpenAICreate.mockResolvedValue({
        choices: [{ message: { content: JSON.stringify(parsed) } }],
        usage: { prompt_tokens: 765, completion_tokens: 120, total_tokens: 885 },
      });

      const result = await new OpenAIVisionClient(config).analyzeVisualDiff(request);
      expect(result.usage).toEqual({ inputTokens: 765, outputTokens: 120, totalTokens: 885 });
    });

    it('leaves usage undefined when the SDK omits it', async () => {
      mockOpenAICreate.mockResolvedValue({
        choices: [{ message: { content: JSON.stringify(parsed) } }],
      });

      const result = await new OpenAIVisionClient(config).analyzeVisualDiff(request);
      expect(result.usage).toBeUndefined();
    });

    it('throws when the API returns no content', async () => {
      mockOpenAICreate.mockResolvedValue({ choices: [{ message: { content: '' } }] });
      const client = new OpenAIVisionClient(config);
      await expect(client.analyzeVisualDiff(request)).rejects.toThrow(/No response from OpenAI/i);
    });

    it('reports availability and vision support from model + key', async () => {
      expect(await new OpenAIVisionClient(config).isAvailable()).toBe(true);
      expect(new OpenAIVisionClient(config).supportsVision()).toBe(true);
      expect(
        new OpenAIVisionClient({ provider: 'openai', apiKey: 'k', model: 'o1' }).supportsVision(),
      ).toBe(false);
      expect(
        await new OpenAIVisionClient({ provider: 'openai', model: 'gpt-4o' }).isAvailable(),
      ).toBe(false);
    });
  });

  describe('AnthropicVisionClient', () => {
    const config: IrisConfig['ai'] = {
      provider: 'anthropic',
      apiKey: 'sk-ant',
      model: 'claude-sonnet-5',
    };

    it('throws when the apiKey is missing', async () => {
      const client = new AnthropicVisionClient({ provider: 'anthropic', model: 'claude-sonnet-5' });
      await expect(client.analyzeVisualDiff(request)).rejects.toThrow(/Anthropic API key/i);
    });

    it('sends the configured model + both images and parses the JSON response', async () => {
      mockAnthropicCreate.mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify(parsed) }],
      });

      const client = new AnthropicVisionClient(config);
      const result = await client.analyzeVisualDiff(request);

      expect(result.severity).toBe('moderate');
      expect(result.categories).toEqual(['layout']);

      const payload = mockAnthropicCreate.mock.calls[0][0];
      expect(payload.model).toBe('claude-sonnet-5');
      const imageBlocks = payload.messages[0].content.filter(
        (b: { type: string }) => b.type === 'image',
      );
      expect(imageBlocks).toHaveLength(2);
      expect(imageBlocks[0].source.data).toBe(baseline.toString('base64'));
      expect(imageBlocks[1].source.data).toBe(current.toString('base64'));
    });

    it('appends the diff mask as a third image and points the prompt at it (issue #124)', async () => {
      mockAnthropicCreate.mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify(parsed) }],
      });

      await new AnthropicVisionClient(config).analyzeVisualDiff(requestWithDiff);

      const content = mockAnthropicCreate.mock.calls[0][0].messages[0].content;
      const imageBlocks = content.filter((b: { type: string }) => b.type === 'image');
      expect(imageBlocks).toHaveLength(3);
      expect(imageBlocks[0].source.data).toBe(baseline.toString('base64'));
      expect(imageBlocks[1].source.data).toBe(current.toString('base64'));
      expect(imageBlocks[2].source.data).toBe(diff.toString('base64'));

      const text = content
        .filter((b: { type: string }) => b.type === 'text')
        .map((b: { text: string }) => b.text)
        .join('\n');
      expect(text).toMatch(/third image/i);
    });

    it('leaves the two-image prompt untouched when no diff is supplied (issue #124)', async () => {
      mockAnthropicCreate.mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify(parsed) }],
      });

      await new AnthropicVisionClient(config).analyzeVisualDiff(request);

      const text = mockAnthropicCreate.mock.calls[0][0].messages[0].content
        .filter((b: { type: string }) => b.type === 'text')
        .map((b: { text: string }) => b.text)
        .join('\n');
      expect(text).not.toMatch(/third image/i);
    });

    it('maps SDK usage into normalized inputTokens/outputTokens (issue #67)', async () => {
      mockAnthropicCreate.mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify(parsed) }],
        usage: { input_tokens: 1600, output_tokens: 90 },
      });

      const result = await new AnthropicVisionClient(config).analyzeVisualDiff(request);
      expect(result.usage).toEqual({ inputTokens: 1600, outputTokens: 90 });
    });

    it('throws when the response block is not text', async () => {
      mockAnthropicCreate.mockResolvedValue({ content: [{ type: 'tool_use' }] });
      const client = new AnthropicVisionClient(config);
      await expect(client.analyzeVisualDiff(request)).rejects.toThrow(/Unexpected response type/i);
    });

    // Issue #183: this used to assert `model.includes('claude-3')`, which was
    // true for everything Anthropic served in 2024 and is false for everything
    // it serves now — the whole claude-3 family is retired. Because
    // `isAvailable()` gates on `supportsVision()`, that substring test dropped
    // the Anthropic client from the fallback chain before it sent a request,
    // and configuring a *current* model made it fail harder, not less.
    //
    // Every Anthropic model in the current lineup is multimodal, so the honest
    // predicate is "this is an Anthropic vision client", not a name match. The
    // list below is deliberately current names rather than a substring.
    it.each(['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5', 'claude-opus-4-8'])(
      'reports vision support for %s',
      (model) => {
        expect(
          new AnthropicVisionClient({ provider: 'anthropic', apiKey: 'k', model }).supportsVision(),
        ).toBe(true);
      },
    );

    it('reports vision support when no model is configured', () => {
      // `model` is a required field, so "unconfigured" reaches the client as an
      // empty string — the case every `this.config.model || '<default>'` guards.
      // vision.ts then requests its default model, so claiming "no vision" here
      // contradicted the request the very same client goes on to make.
      expect(
        new AnthropicVisionClient({
          provider: 'anthropic',
          apiKey: 'k',
          model: '',
        }).supportsVision(),
      ).toBe(true);
    });

    it('is available whenever an API key is present', () => {
      expect(
        new AnthropicVisionClient({ provider: 'anthropic', apiKey: 'k', model: 'claude-sonnet-5' }),
      ).toBeDefined();
      return expect(
        new AnthropicVisionClient({
          provider: 'anthropic',
          apiKey: 'k',
          model: 'claude-sonnet-5',
        }).isAvailable(),
      ).resolves.toBe(true);
    });
  });

  // Issue #162: every provider image was labelled image/png while the default
  // preprocessor encodes JPEG. OpenAI sniffs the data URL and tolerated it;
  // Anthropic validates media_type against the bytes, so its vision path failed
  // inside analyzeVisualDiff's try/catch and surfaced only as a generic
  // "all providers failed" after the fallback chain gave up.
  describe('declared MIME type matches the actual bytes (issue #162)', () => {
    const openaiConfig: IrisConfig['ai'] = {
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4o',
    };
    const anthropicConfig: IrisConfig['ai'] = {
      provider: 'anthropic',
      apiKey: 'sk-ant',
      model: 'claude-sonnet-5',
    };

    beforeEach(() => {
      mockOpenAICreate.mockResolvedValue({
        choices: [{ message: { content: JSON.stringify(parsed) } }],
      });
      mockAnthropicCreate.mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify(parsed) }],
      });
    });

    it.each([
      ['jpeg', 'image/jpeg'],
      ['png', 'image/png'],
      ['webp', 'image/webp'],
    ] as const)('labels %s bytes as %s for OpenAI', async (format, expected) => {
      const bytes = await encode(format);

      await new OpenAIVisionClient(openaiConfig).analyzeVisualDiff({
        baseline: bytes,
        current: bytes,
      });

      const userContent = mockOpenAICreate.mock.calls[0][0].messages.find(
        (m: { role: string }) => m.role === 'user',
      ).content;
      const imageParts = userContent.filter((p: { type: string }) => p.type === 'image_url');
      expect(imageParts).toHaveLength(2);
      for (const part of imageParts) {
        expect(part.image_url.url.startsWith(`data:${expected};base64,`)).toBe(true);
      }
    });

    it.each([
      ['jpeg', 'image/jpeg'],
      ['png', 'image/png'],
      ['webp', 'image/webp'],
    ] as const)('labels %s bytes as %s for Anthropic', async (format, expected) => {
      const bytes = await encode(format);

      await new AnthropicVisionClient(anthropicConfig).analyzeVisualDiff({
        baseline: bytes,
        current: bytes,
      });

      const content = mockAnthropicCreate.mock.calls[0][0].messages[0].content;
      const images = content.filter((p: { type: string }) => p.type === 'image');
      expect(images).toHaveLength(2);
      for (const image of images) {
        expect(image.source.media_type).toBe(expected);
      }
    });

    it('labels each image independently, so a PNG diff mask beside JPEG screenshots is honest', async () => {
      // This is the real shipped combination: SmartAIVisionClient preprocesses
      // screenshots to JPEG but the diff mask to PNG (alpha preservation, #124).
      // A single per-request MIME type would have to be wrong for one of them.
      const jpeg = await encode('jpeg');
      const png = await encode('png');

      await new AnthropicVisionClient(anthropicConfig).analyzeVisualDiff({
        baseline: jpeg,
        current: jpeg,
        diff: png,
      });

      const content = mockAnthropicCreate.mock.calls[0][0].messages[0].content;
      const images = content.filter((p: { type: string }) => p.type === 'image');
      expect(images.map((i: { source: { media_type: string } }) => i.source.media_type)).toEqual([
        'image/jpeg',
        'image/jpeg',
        'image/png',
      ]);
    });

    it('falls back to image/png for bytes it cannot identify', async () => {
      // Never throw on an unrecognised buffer: a wrong-but-plausible label is
      // still better than turning an analysis into an error, and PNG is what
      // this code claimed for years.
      await new OpenAIVisionClient(openaiConfig).analyzeVisualDiff({
        baseline: Buffer.from('not-an-image'),
        current: Buffer.from('not-an-image'),
      });

      const userContent = mockOpenAICreate.mock.calls[0][0].messages.find(
        (m: { role: string }) => m.role === 'user',
      ).content;
      const imageParts = userContent.filter((p: { type: string }) => p.type === 'image_url');
      expect(imageParts[0].image_url.url.startsWith('data:image/png;base64,')).toBe(true);
    });
  });

  describe('OllamaVisionClient', () => {
    const config: IrisConfig['ai'] = {
      provider: 'ollama',
      endpoint: 'http://localhost:11434',
      model: 'llava',
    };

    afterEach(() => {
      (global.fetch as jest.Mock | undefined)?.mockReset?.();
    });

    it('throws when the endpoint is missing', async () => {
      const client = new OllamaVisionClient({ provider: 'ollama', model: 'llava' });
      await expect(client.analyzeVisualDiff(request)).rejects.toThrow(/Ollama endpoint/i);
    });

    it('POSTs both images to /api/generate and parses the JSON response', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ response: JSON.stringify(parsed) }),
      });

      const client = new OllamaVisionClient(config);
      const result = await client.analyzeVisualDiff(request);

      expect(result.severity).toBe('moderate');
      const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
      expect(url).toBe('http://localhost:11434/api/generate');
      const body = JSON.parse(init.body);
      expect(body.model).toBe('llava');
      expect(body.images).toEqual([baseline.toString('base64'), current.toString('base64')]);
    });

    it('appends the diff mask as a third image and points the prompt at it (issue #124)', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ response: JSON.stringify(parsed) }),
      });

      await new OllamaVisionClient(config).analyzeVisualDiff(requestWithDiff);

      const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
      expect(body.images).toEqual([
        baseline.toString('base64'),
        current.toString('base64'),
        diff.toString('base64'),
      ]);
      expect(body.prompt).toMatch(/third image/i);
    });

    it('leaves the two-image prompt untouched when no diff is supplied (issue #124)', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ response: JSON.stringify(parsed) }),
      });

      await new OllamaVisionClient(config).analyzeVisualDiff(request);

      const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
      expect(body.prompt).not.toMatch(/third image/i);
    });

    it('maps prompt_eval_count/eval_count into normalized usage (issue #67)', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          response: JSON.stringify(parsed),
          prompt_eval_count: 500,
          eval_count: 40,
        }),
      });

      const result = await new OllamaVisionClient(config).analyzeVisualDiff(request);
      expect(result.usage).toEqual({ inputTokens: 500, outputTokens: 40 });
    });

    it('surfaces a non-ok HTTP response as an error', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });
      // maxRetries:0 — 500 is transient, so the default config would retry ~3x
      // with backoff and slow the test; we only need one deterministic attempt.
      const client = new OllamaVisionClient({
        ...config,
        retryConfig: { maxRetries: 0, initialDelayMs: 0, backoffMultiplier: 1 },
      });
      await expect(client.analyzeVisualDiff(request)).rejects.toThrow(/Ollama request failed: 500/);
      expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);
    });

    it('isAvailable() true only when a llava-family model is present', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ models: [{ name: 'llava:latest' }] }),
      });
      expect(await new OllamaVisionClient(config).isAvailable()).toBe(true);

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ models: [{ name: 'mistral' }] }),
      });
      expect(await new OllamaVisionClient(config).isAvailable()).toBe(false);
    });
  });

  // Issue #183: the default was claude-3-5-sonnet-20241022, which 404s — the
  // whole claude-3 family is retired. Assert the request carries a model the
  // account can actually reach when the user configures none.
  describe('default model when none is configured (issue #183)', () => {
    it('requests a current Anthropic model', async () => {
      mockAnthropicCreate.mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify(parsed) }],
      });

      await new AnthropicVisionClient({
        provider: 'anthropic',
        apiKey: 'sk-ant',
        model: '',
      }).analyzeVisualDiff(request);

      expect(mockAnthropicCreate.mock.calls[0][0].model).toBe('claude-sonnet-5');
    });
  });
});

// Issue #183 is the third recurrence of the same failure (#111 was the first,
// #162's diagnosis surfaced this one): a model ID that was correct when written
// and expired on the vendor's schedule. This scans for the retired family by
// name so a re-added pin fails here rather than at runtime, where the fallback
// chain swallows it. It cannot catch a *future* retirement — resolving defaults
// from the provider's model list is issue #184.
describe('no retired claude-3 model IDs remain in src/ (issue #183)', () => {
  it('finds no quoted claude-3-* model ID', () => {
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return entry.isFile() && full.endsWith('.ts') ? [full] : [];
      });

    // Comments are stripped first: prose explaining *why* the old pin was wrong
    // quotes the retired name, and documentation is not a live pin. Without
    // this, the fix's own explanatory comment fails the test that guards it.
    const stripComments = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

    const pin = /['"`]claude-3[^'"`]*['"`]/;
    const offenders = walk(path.join(__dirname, '..', 'src'))
      .filter((file) => pin.test(stripComments(fs.readFileSync(file, 'utf8'))))
      .map((file) => path.relative(path.join(__dirname, '..'), file));

    expect(offenders).toEqual([]);
  });
});
