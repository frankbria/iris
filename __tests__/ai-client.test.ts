import { createAIClient } from '../src/ai-client';
import { IrisConfig } from '../src/config';
import { resetModelProbeCache } from '../src/ai-client/models';

// Mock OpenAI
const mockCreate = jest.fn();
jest.mock('openai', () => ({
  OpenAI: jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: mockCreate,
      },
    },
  })),
}));

// Mock Anthropic
const mockMessagesCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => ({
  Anthropic: jest.fn().mockImplementation(() => ({
    messages: {
      create: mockMessagesCreate,
    },
  })),
}));

// Mock fetch for Ollama
global.fetch = jest.fn();

describe('AI Client', () => {
  beforeEach(() => {
    // The Ollama availability probe is cached per process (#298).
    resetModelProbeCache();
    jest.clearAllMocks();
  });

  describe('OpenAI Client', () => {
    const config: IrisConfig = {
      ai: {
        provider: 'openai',
        apiKey: 'sk-test-key',
        model: 'gpt-4o-mini',
      },
      watch: { patterns: [], debounceMs: 1000, ignore: [] },
      browser: { headless: true, timeout: 30000 },
    };

    it('should create OpenAI client', () => {
      const client = createAIClient(config);
      expect(client).toBeDefined();
    });

    it('should be available when API key is provided', async () => {
      const client = createAIClient(config);
      const isAvailable = await client.isAvailable();
      expect(isAvailable).toBe(true);
    });

    it('should not be available without API key', async () => {
      const configWithoutKey = {
        ...config,
        ai: { ...config.ai, apiKey: undefined },
      };
      const client = createAIClient(configWithoutKey);
      const isAvailable = await client.isAvailable();
      expect(isAvailable).toBe(false);
    });

    it('should translate instruction successfully', async () => {
      mockCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                actions: [{ type: 'click', selector: '#submit' }],
                confidence: 0.9,
                reasoning: 'Clear click instruction',
              }),
            },
          },
        ],
      });

      const client = createAIClient(config);
      const result = await client.translateInstruction({
        instruction: 'click the submit button',
      });

      expect(result.actions).toHaveLength(1);
      expect(result.actions[0]).toEqual({ type: 'click', selector: '#submit' });
      expect(result.confidence).toBe(0.9);
      expect(result.reasoning).toBe('Clear click instruction');
      // Not the deprecated max_tokens (#298).
      expect(mockCreate.mock.calls[0][0].max_completion_tokens).toBe(1000);
      expect(mockCreate.mock.calls[0][0]).not.toHaveProperty('max_tokens');
      expect(mockCreate.mock.calls[0][0].temperature).toBe(0.1);
    });

    // #523: gpt-5.x and gpt-6 are told not to reason (`low` where `none` is refused) and
    // are sent no temperature, which they refuse unless effort is `none`.
    it.each([
      ['gpt-6-luna', 'none'],
      ['gpt-6-sol', 'none'],
      ['gpt-6.1-terra', 'none'],
      ['gpt-5.6-sol', 'none'],
      ['gpt-5.4-mini-2026-03-17', 'none'],
      ['gpt-6-astra', 'low'],
      ['gpt-6.1-sol', 'low'],
    ])('sends %s reasoning_effort %s and no temperature', async (model, effort) => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: JSON.stringify({ actions: [], confidence: 0 }) } }],
      });
      const client = createAIClient({ ...config, ai: { ...config.ai, model } });
      await client.translateInstruction({ instruction: 'click the submit button' });
      expect(mockCreate.mock.calls[0][0].reasoning_effort).toBe(effort);
      expect(mockCreate.mock.calls[0][0]).not.toHaveProperty('temperature');
    });

    // gpt-4o and gpt-4.1 do not reason: they keep 0.1.
    it.each(['gpt-4o-mini', 'gpt-4.1'])(
      'sends %s a temperature and no reasoning_effort',
      async (model) => {
        mockCreate.mockResolvedValue({
          choices: [{ message: { content: JSON.stringify({ actions: [], confidence: 0 }) } }],
        });
        const client = createAIClient({ ...config, ai: { ...config.ai, model } });
        await client.translateInstruction({ instruction: 'click the submit button' });
        expect(mockCreate.mock.calls[0][0].temperature).toBe(0.1);
        expect(mockCreate.mock.calls[0][0]).not.toHaveProperty('reasoning_effort');
      },
    );

    // #520: the o-series refuses any temperature but the default.
    // #523: nor does the first gpt-5, which also has no `none` effort to ask for.
    it.each([
      'o1',
      'o3-mini',
      'o4-mini-2025-04-16',
      'gpt-5',
      'gpt-5-mini',
      'gpt-5-nano-2025-08-07',
    ])('sends no temperature to %s', async (model) => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: JSON.stringify({ actions: [], confidence: 0 }) } }],
      });
      const client = createAIClient({ ...config, ai: { ...config.ai, model } });
      await client.translateInstruction({ instruction: 'click the submit button' });
      expect(mockCreate.mock.calls[0][0]).not.toHaveProperty('temperature');
      expect(mockCreate.mock.calls[0][0]).not.toHaveProperty('reasoning_effort');
    });

    // #652: a fine-tuned id is `ft:<base model>:<org>:<suffix>:<id>`, and the family
    // patterns anchor at the start, so it used to fall through to `temperature: 0.1`,
    // which a gpt-6 or o-series base refuses with a 400.
    it.each([
      ['ft:gpt-6-luna:acme::Abc123', { reasoning_effort: 'none' }],
      ['ft:gpt-6-astra:acme:support:Abc123', { reasoning_effort: 'low' }],
      ['ft:gpt-5.4-mini-2026-03-17:acme::Abc123', { reasoning_effort: 'none' }],
      ['ft:o4-mini-2025-04-16:acme::Abc123', {}],
      ['ft:gpt-5-mini:acme::Abc123', {}],
      ['ft:gpt-4.1-mini-2025-04-14:acme::Abc123', { temperature: 0.1 }],
      // Not a fine-tuned id: `ft:` only counts at the start.
      ['my-ft:gpt-6-luna', { temperature: 0.1 }],
    ])("sends the fine-tuned %s its base model's sampling options", async (model, sampling) => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: JSON.stringify({ actions: [], confidence: 0 }) } }],
      });
      const client = createAIClient({ ...config, ai: { ...config.ai, model } });
      await client.translateInstruction({ instruction: 'click the submit button' });
      const { temperature, reasoning_effort } = mockCreate.mock.calls[0][0];
      expect(JSON.parse(JSON.stringify({ temperature, reasoning_effort }))).toEqual(sampling);
      expect(mockCreate.mock.calls[0][0].model).toBe(model);
    });

    it('should handle API errors gracefully', async () => {
      mockCreate.mockRejectedValue(new Error('API Error'));

      const client = createAIClient(config);
      const result = await client.translateInstruction({
        instruction: 'click submit',
      });

      expect(result.actions).toHaveLength(0);
      expect(result.confidence).toBe(0);
      expect(result.reasoning).toContain('Failed to translate: API Error');
      // A failure is marked as one, so a caller can tell it from an empty plan (#293).
      expect(result.error).toBe('API Error');
    });
  });

  describe('Anthropic Client', () => {
    const config: IrisConfig = {
      ai: {
        provider: 'anthropic',
        apiKey: 'ant-test-key',
        model: 'claude-haiku-4-5',
      },
      watch: { patterns: [], debounceMs: 1000, ignore: [] },
      browser: { headless: true, timeout: 30000 },
    };

    it('should create Anthropic client', () => {
      const client = createAIClient(config);
      expect(client).toBeDefined();
    });

    it('should be available when API key is provided', async () => {
      const client = createAIClient(config);
      const isAvailable = await client.isAvailable();
      expect(isAvailable).toBe(true);
    });

    it('should not be available without API key', async () => {
      const configWithoutKey = {
        ...config,
        ai: { ...config.ai, apiKey: undefined },
      };
      const client = createAIClient(configWithoutKey);
      const isAvailable = await client.isAvailable();
      expect(isAvailable).toBe(false);
    });

    it('should translate instruction successfully', async () => {
      mockMessagesCreate.mockResolvedValue({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              actions: [{ type: 'click', selector: '#submit' }],
              confidence: 0.9,
              reasoning: 'Clear click instruction',
            }),
          },
        ],
      });

      const client = createAIClient(config);
      const result = await client.translateInstruction({
        instruction: 'click the submit button',
      });

      expect(result.actions).toHaveLength(1);
      expect(result.actions[0]).toEqual({ type: 'click', selector: '#submit' });
      expect(result.confidence).toBe(0.9);
      expect(result.reasoning).toBe('Clear click instruction');
      // API version 2026-10-21 removed sampling parameters from the Messages API.
      expect(mockMessagesCreate.mock.calls[0][0]).not.toHaveProperty('temperature');
    });

    it('should handle API errors gracefully', async () => {
      mockMessagesCreate.mockRejectedValue(new Error('API Error'));

      const client = createAIClient(config);
      const result = await client.translateInstruction({
        instruction: 'click submit',
      });

      expect(result.actions).toHaveLength(0);
      expect(result.confidence).toBe(0);
      expect(result.reasoning).toContain('Failed to translate: API Error');
      // A failure is marked as one, so a caller can tell it from an empty plan (#293).
      expect(result.error).toBe('API Error');
    });

    it('should preserve a legitimate confidence of 0', async () => {
      mockMessagesCreate.mockResolvedValue({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ actions: [], confidence: 0, reasoning: 'Unclear' }),
          },
        ],
      });

      const client = createAIClient(config);
      const result = await client.translateInstruction({ instruction: 'do something' });

      expect(result.confidence).toBe(0);
      expect(result.error).toBeUndefined();
    });
  });

  describe('Ollama Client', () => {
    const config: IrisConfig = {
      ai: {
        provider: 'ollama',
        endpoint: 'http://localhost:11434',
        model: 'llama2',
      },
      watch: { patterns: [], debounceMs: 1000, ignore: [] },
      browser: { headless: true, timeout: 30000 },
    };

    it('should create Ollama client', () => {
      const client = createAIClient(config);
      expect(client).toBeDefined();
    });

    it('should check availability via API', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ models: [] }),
      });

      const client = createAIClient(config);
      const isAvailable = await client.isAvailable();

      expect(isAvailable).toBe(true);
      // Bounded since #298: the call carries an abort signal.
      expect((fetch as jest.Mock).mock.calls[0][0]).toBe('http://localhost:11434/api/tags');
    });

    it('should not be available when endpoint is unreachable', async () => {
      (global.fetch as jest.Mock).mockRejectedValue(new Error('Connection failed'));

      const client = createAIClient(config);
      const isAvailable = await client.isAvailable();
      expect(isAvailable).toBe(false);
    });

    it('should translate instruction via Ollama API', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            response: JSON.stringify({
              actions: [{ type: 'click', selector: 'button' }],
              confidence: 0.8,
              reasoning: 'Ollama translation',
            }),
          }),
      });

      const client = createAIClient(config);
      const result = await client.translateInstruction({
        instruction: 'click button',
      });

      expect(result.actions).toHaveLength(1);
      expect(result.actions[0]).toEqual({ type: 'click', selector: 'button' });
      expect(result.confidence).toBe(0.8);
    });

    it('should handle Ollama API errors', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status: 500,
      });

      const client = createAIClient(config);
      const result = await client.translateInstruction({
        instruction: 'click button',
      });

      expect(result.actions).toHaveLength(0);
      expect(result.confidence).toBe(0);
      expect(result.reasoning).toContain('Failed to translate with Ollama');
      expect(result.error).toContain('Ollama request failed: 500');
    });
  });

  describe('createAIClient', () => {
    it('should throw error for unsupported provider', () => {
      const config = {
        ai: { provider: 'unsupported' as any, model: 'test' },
        watch: { patterns: [], debounceMs: 1000, ignore: [] },
        browser: { headless: true, timeout: 30000 },
      };

      expect(() => createAIClient(config)).toThrow('Unsupported AI provider: unsupported');
    });
  });
});
