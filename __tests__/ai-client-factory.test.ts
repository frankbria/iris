/**
 * Tests for AIClientFactory (src/ai-client/factory.ts) — provider→client
 * mapping had zero coverage (issue #62 / P0.9).
 */

import type { IrisConfig } from '../src/config';
import { AIClientFactory, createAIClient, createResolvedAIClient } from '../src/ai-client/factory';
import {
  DEFAULT_MODELS,
  ModelUnavailableError,
  resetModelProbeCache,
} from '../src/ai-client/models';
import { OpenAITextClient, AnthropicTextClient, OllamaTextClient } from '../src/ai-client/text';
import {
  OpenAIVisionClient,
  AnthropicVisionClient,
  OllamaVisionClient,
} from '../src/ai-client/vision';

const cfg = (provider: string, model?: string): IrisConfig =>
  ({
    ai: { provider: provider as IrisConfig['ai']['provider'], apiKey: 'k', model },
    watch: { patterns: [], debounceMs: 1000, ignore: [] },
    browser: { headless: true, timeout: 30000 },
  }) as IrisConfig;

describe('AIClientFactory', () => {
  describe('text clients', () => {
    it.each([
      ['openai', OpenAITextClient],
      ['anthropic', AnthropicTextClient],
      ['ollama', OllamaTextClient],
    ])('maps %s → its text client', (provider, ctor) => {
      expect(AIClientFactory.create(cfg(provider), 'text')).toBeInstanceOf(ctor);
    });

    it('defaults to a text client when type is omitted', () => {
      expect(AIClientFactory.create(cfg('openai'))).toBeInstanceOf(OpenAITextClient);
    });

    it('throws on an unsupported text provider', () => {
      expect(() => AIClientFactory.create(cfg('bogus'), 'text')).toThrow(
        /Unsupported AI provider/i,
      );
    });
  });

  describe('vision clients', () => {
    it.each([
      ['openai', OpenAIVisionClient],
      ['anthropic', AnthropicVisionClient],
      ['ollama', OllamaVisionClient],
    ])('maps %s → its vision client', (provider, ctor) => {
      expect(AIClientFactory.create(cfg(provider), 'vision')).toBeInstanceOf(ctor);
    });

    it('throws on an unsupported vision provider', () => {
      expect(() => AIClientFactory.create(cfg('bogus'), 'vision')).toThrow(
        /Unsupported AI provider for vision/i,
      );
    });
  });

  describe('supportsVision', () => {
    it('is true for a vision-capable model', () => {
      expect(AIClientFactory.supportsVision(cfg('openai', 'gpt-4o'))).toBe(true);
    });

    it('is false for a non-vision model', () => {
      expect(AIClientFactory.supportsVision(cfg('openai', 'o1-mini'))).toBe(false);
    });

    it('is false (no throw) for an unsupported provider', () => {
      expect(AIClientFactory.supportsVision(cfg('bogus'))).toBe(false);
    });
  });

  it('createAIClient() returns a text client for backward compatibility', () => {
    expect(createAIClient(cfg('anthropic'))).toBeInstanceOf(AnthropicTextClient);
  });

  // Issue #184: the text path used to trust config.ai.model verbatim, so a pin
  // the vendor had retired reached the wire and came back as an opaque 404.
  describe('createResolvedAIClient', () => {
    const mockFetch = jest.fn();

    beforeEach(() => {
      jest.clearAllMocks();
      resetModelProbeCache();
      // jest.setup.ts turns the probe off suite-wide for hermeticity.
      delete process.env.IRIS_MODEL_PROBE;
      global.fetch = mockFetch as unknown as typeof fetch;
    });

    afterEach(() => {
      process.env.IRIS_MODEL_PROBE = '0';
    });

    const listing = (...ids: string[]) => ({
      ok: true,
      status: 200,
      json: async () => ({ data: ids.map((id) => ({ id })) }),
    });

    it('builds a client on the resolved model, replacing a retired pin', async () => {
      mockFetch.mockResolvedValue(listing('claude-haiku-4-5-20260101', 'claude-sonnet-5'));

      const client = (await createResolvedAIClient(
        cfg('anthropic', DEFAULT_MODELS.text.anthropic),
      )) as AnthropicTextClient & { config: { model: string } };

      expect(client).toBeInstanceOf(AnthropicTextClient);
      expect(client.config.model).toBe('claude-haiku-4-5-20260101');
    });

    it('rejects with a named error when the configured model does not exist', async () => {
      mockFetch.mockResolvedValue(listing('claude-sonnet-5'));

      await expect(
        createResolvedAIClient(cfg('anthropic', 'claude-3-opus-20240229')),
      ).rejects.toBeInstanceOf(ModelUnavailableError);
    });

    it('still builds a client when the probe cannot run', async () => {
      mockFetch.mockRejectedValue(new Error('fetch failed'));

      const client = (await createResolvedAIClient(
        cfg('anthropic', 'claude-private-build'),
      )) as AnthropicTextClient & { config: { model: string } };

      expect(client.config.model).toBe('claude-private-build');
    });
  });
});
