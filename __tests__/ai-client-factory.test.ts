/**
 * Tests for AIClientFactory (src/ai-client/factory.ts) — provider→client
 * mapping had zero coverage (issue #62 / P0.9).
 */

import type { IrisConfig } from '../src/config';
import { AIClientFactory, createAIClient } from '../src/ai-client/factory';
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
});
