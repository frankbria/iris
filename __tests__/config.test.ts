import { loadConfig, validateConfig, saveConfig } from '../src/config';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock fs and os modules
jest.mock('fs');
jest.mock('os');

const mockFs = fs as jest.Mocked<typeof fs>;
const mockOs = os as jest.Mocked<typeof os>;

describe('Config System', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset environment variables
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OLLAMA_ENDPOINT;
    delete process.env.OLLAMA_MODEL;
  });

  describe('loadConfig', () => {
    it('should load default config when no config file exists', () => {
      mockOs.homedir.mockReturnValue('/home/test');
      mockFs.existsSync.mockReturnValue(false);

      const config = loadConfig();

      expect(config.ai.provider).toBe('openai');
      expect(config.ai.model).toBe('gpt-4o-mini');
      expect(config.watch.debounceMs).toBe(1000);
    });

    it('should load config from environment variables', () => {
      process.env.OPENAI_API_KEY = 'sk-test-key';
      mockOs.homedir.mockReturnValue('/home/test');
      mockFs.existsSync.mockReturnValue(false);

      const config = loadConfig();

      expect(config.ai.provider).toBe('openai');
      expect(config.ai.apiKey).toBe('sk-test-key');
    });

    it('should load Anthropic config from environment', () => {
      process.env.ANTHROPIC_API_KEY = 'ant-test-key';
      mockOs.homedir.mockReturnValue('/home/test');
      mockFs.existsSync.mockReturnValue(false);

      const config = loadConfig();

      expect(config.ai.provider).toBe('anthropic');
      expect(config.ai.apiKey).toBe('ant-test-key');
      expect(config.ai.model).toBe('claude-3-haiku-20240307');
    });

    it('should load Ollama config from environment', () => {
      process.env.OLLAMA_ENDPOINT = 'http://localhost:11434';
      process.env.OLLAMA_MODEL = 'llama2';
      mockOs.homedir.mockReturnValue('/home/test');
      mockFs.existsSync.mockReturnValue(false);

      const config = loadConfig();

      expect(config.ai.provider).toBe('ollama');
      expect(config.ai.endpoint).toBe('http://localhost:11434');
      expect(config.ai.model).toBe('llama2');
    });

    it('should merge config file with defaults', () => {
      const configContent = JSON.stringify({
        ai: { model: 'gpt-4' },
        watch: { debounceMs: 2000 }
      });

      mockOs.homedir.mockReturnValue('/home/test');
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(configContent);

      const config = loadConfig();

      expect(config.ai.provider).toBe('openai'); // from default
      expect(config.ai.model).toBe('gpt-4'); // from file
      expect(config.watch.debounceMs).toBe(2000); // from file
      expect(config.browser.headless).toBe(true); // from default
    });
  });

  describe('validateConfig', () => {
    it('should validate OpenAI config', () => {
      const config = {
        ai: { provider: 'openai' as const, model: 'gpt-4o-mini' },
        watch: { patterns: ['**/*.ts'], debounceMs: 1000, ignore: ['node_modules/**'] },
        browser: { headless: true, timeout: 30000 }
      };

      const errors = validateConfig(config);
      expect(errors).toContain('OpenAI API key is required. Set OPENAI_API_KEY environment variable or configure in ~/.iris/config.json');
    });

    it('should validate Anthropic config', () => {
      const config = {
        ai: { provider: 'anthropic' as const, model: 'claude-3-haiku-20240307' },
        watch: { patterns: ['**/*.ts'], debounceMs: 1000, ignore: ['node_modules/**'] },
        browser: { headless: true, timeout: 30000 }
      };

      const errors = validateConfig(config);
      expect(errors).toContain('Anthropic API key is required. Set ANTHROPIC_API_KEY environment variable or configure in ~/.iris/config.json');
    });

    it('should validate Ollama config', () => {
      const config = {
        ai: { provider: 'ollama' as const, model: 'llama2' },
        watch: { patterns: ['**/*.ts'], debounceMs: 1000, ignore: ['node_modules/**'] },
        browser: { headless: true, timeout: 30000 }
      };

      const errors = validateConfig(config);
      expect(errors).toContain('Ollama endpoint is required. Set OLLAMA_ENDPOINT environment variable or configure in ~/.iris/config.json');
    });

    it('should validate timing constraints', () => {
      const config = {
        ai: { provider: 'openai' as const, apiKey: 'sk-test', model: 'gpt-4o-mini' },
        watch: { patterns: ['**/*.ts'], debounceMs: 50, ignore: ['node_modules/**'] },
        browser: { headless: true, timeout: 500 }
      };

      const errors = validateConfig(config);
      expect(errors).toContain('Watch debounce must be at least 100ms');
      expect(errors).toContain('Browser timeout must be at least 1000ms');
    });

    it('should pass valid config', () => {
      const config = {
        ai: { provider: 'openai' as const, apiKey: 'sk-test', model: 'gpt-4o-mini' },
        watch: { patterns: ['**/*.ts'], debounceMs: 1000, ignore: ['node_modules/**'] },
        browser: { headless: true, timeout: 30000 }
      };

      const errors = validateConfig(config);
      expect(errors).toHaveLength(0);
    });
  });

  describe('saveConfig', () => {
    it('should save config to file', () => {
      const config = {
        ai: { provider: 'openai' as const, apiKey: 'sk-test', model: 'gpt-4o-mini' },
        watch: { patterns: ['**/*.ts'], debounceMs: 1000, ignore: ['node_modules/**'] },
        browser: { headless: true, timeout: 30000 }
      };

      mockOs.homedir.mockReturnValue('/home/test');
      mockFs.existsSync.mockReturnValue(false);
      mockFs.mkdirSync.mockImplementation(() => undefined);
      mockFs.writeFileSync.mockImplementation(() => undefined);

      saveConfig(config);

      expect(mockFs.mkdirSync).toHaveBeenCalledWith('/home/test/.iris', { recursive: true });
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        '/home/test/.iris/config.json',
        JSON.stringify(config, null, 2)
      );
    });
  });
});