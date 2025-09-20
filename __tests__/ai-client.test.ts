import { createAIClient } from '../src/ai-client';
import { IrisConfig } from '../src/config';

// Mock OpenAI
jest.mock('openai', () => ({
  OpenAI: jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: jest.fn(),
      },
    },
  })),
}));

// Mock fetch for Ollama
global.fetch = jest.fn();

describe('AI Client', () => {
  beforeEach(() => {
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
        ai: { ...config.ai, apiKey: undefined }
      };
      const client = createAIClient(configWithoutKey);
      const isAvailable = await client.isAvailable();
      expect(isAvailable).toBe(false);
    });

    it('should translate instruction successfully', async () => {
      const { OpenAI } = await import('openai');
      const mockCreate = jest.fn().mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              actions: [{ type: 'click', selector: '#submit' }],
              confidence: 0.9,
              reasoning: 'Clear click instruction'
            })
          }
        }]
      });

      (OpenAI as jest.MockedClass<typeof OpenAI>).mockImplementation(() => ({
        chat: { completions: { create: mockCreate } }
      }));

      const client = createAIClient(config);
      const result = await client.translateInstruction({
        instruction: 'click the submit button'
      });

      expect(result.actions).toHaveLength(1);
      expect(result.actions[0]).toEqual({ type: 'click', selector: '#submit' });
      expect(result.confidence).toBe(0.9);
      expect(result.reasoning).toBe('Clear click instruction');
    });

    it('should handle API errors gracefully', async () => {
      const { OpenAI } = await import('openai');
      const mockCreate = jest.fn().mockRejectedValue(new Error('API Error'));

      (OpenAI as jest.MockedClass<typeof OpenAI>).mockImplementation(() => ({
        chat: { completions: { create: mockCreate } }
      }));

      const client = createAIClient(config);
      const result = await client.translateInstruction({
        instruction: 'click submit'
      });

      expect(result.actions).toHaveLength(0);
      expect(result.confidence).toBe(0);
      expect(result.reasoning).toContain('Failed to translate: API Error');
    });
  });

  describe('Anthropic Client', () => {
    const config: IrisConfig = {
      ai: {
        provider: 'anthropic',
        apiKey: 'ant-test-key',
        model: 'claude-3-haiku-20240307',
      },
      watch: { patterns: [], debounceMs: 1000, ignore: [] },
      browser: { headless: true, timeout: 30000 },
    };

    it('should create Anthropic client', () => {
      const client = createAIClient(config);
      expect(client).toBeDefined();
    });

    it('should not be available (not implemented)', async () => {
      const client = createAIClient(config);
      const isAvailable = await client.isAvailable();
      expect(isAvailable).toBe(false);
    });

    it('should return placeholder response', async () => {
      const client = createAIClient(config);
      const result = await client.translateInstruction({
        instruction: 'click submit'
      });

      expect(result.actions).toHaveLength(0);
      expect(result.confidence).toBe(0);
      expect(result.reasoning).toBe('Anthropic client not yet implemented');
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
      });

      const client = createAIClient(config);
      const isAvailable = await client.isAvailable();

      expect(isAvailable).toBe(true);
      expect(fetch).toHaveBeenCalledWith('http://localhost:11434/api/tags');
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
        json: () => Promise.resolve({
          response: JSON.stringify({
            actions: [{ type: 'click', selector: 'button' }],
            confidence: 0.8,
            reasoning: 'Ollama translation'
          })
        })
      });

      const client = createAIClient(config);
      const result = await client.translateInstruction({
        instruction: 'click button'
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
        instruction: 'click button'
      });

      expect(result.actions).toHaveLength(0);
      expect(result.confidence).toBe(0);
      expect(result.reasoning).toContain('Failed to translate with Ollama');
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