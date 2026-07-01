/**
 * Tests for the vision provider clients (src/ai-client/vision.ts).
 *
 * These success/parse paths had zero coverage (issue #62 / P0.9): the SDK
 * request payload, the JSON response parsing, and the missing-key / bad-response
 * error paths were never exercised. SDK boundaries are mocked; everything else
 * is the real client.
 */

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
const request = { baseline, current, context: { url: 'https://example.com' } };

const parsed = {
  severity: 'moderate',
  confidence: 0.9,
  reasoning: 'Header moved down',
  categories: ['layout'],
  suggestions: ['Check flexbox'],
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

    it('applies defaults for fields the model omits', async () => {
      mockOpenAICreate.mockResolvedValue({
        choices: [{ message: { content: JSON.stringify({ reasoning: 'x' }) } }],
      });

      const client = new OpenAIVisionClient(config);
      const result = await client.analyzeVisualDiff(request);

      expect(result.severity).toBe('none');
      expect(result.confidence).toBe(0.5);
      expect(result.categories).toEqual([]);
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
      model: 'claude-3-5-sonnet-20241022',
    };

    it('throws when the apiKey is missing', async () => {
      const client = new AnthropicVisionClient({ provider: 'anthropic', model: 'claude-3-5' });
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
      expect(payload.model).toBe('claude-3-5-sonnet-20241022');
      const imageBlocks = payload.messages[0].content.filter(
        (b: { type: string }) => b.type === 'image',
      );
      expect(imageBlocks).toHaveLength(2);
      expect(imageBlocks[0].source.data).toBe(baseline.toString('base64'));
      expect(imageBlocks[1].source.data).toBe(current.toString('base64'));
    });

    it('throws when the response block is not text', async () => {
      mockAnthropicCreate.mockResolvedValue({ content: [{ type: 'tool_use' }] });
      const client = new AnthropicVisionClient(config);
      await expect(client.analyzeVisualDiff(request)).rejects.toThrow(/Unexpected response type/i);
    });

    it('reports vision support only for claude-3 models', () => {
      expect(new AnthropicVisionClient(config).supportsVision()).toBe(true);
      expect(
        new AnthropicVisionClient({
          provider: 'anthropic',
          apiKey: 'k',
          model: 'claude-2',
        }).supportsVision(),
      ).toBe(false);
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

    it('surfaces a non-ok HTTP response as an error', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });
      const client = new OllamaVisionClient(config);
      await expect(client.analyzeVisualDiff(request)).rejects.toThrow(/Ollama request failed: 500/);
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
});
