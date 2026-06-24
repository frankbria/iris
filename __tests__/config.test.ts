import { loadConfig, validateConfig, saveConfig, loadDotenv } from '../src/config';
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

  afterEach(() => {
    // Additional cleanup after each test
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

    it('should merge config file with defaults', () => {
      // This test should run before any environment variable tests
      // to avoid pollution from previous tests

      // Explicitly ensure clean environment before this test
      delete process.env.OPENAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OLLAMA_ENDPOINT;
      delete process.env.OLLAMA_MODEL;

      const configContent = JSON.stringify({
        ai: { model: 'gpt-4' },
        watch: { debounceMs: 2000 },
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
      // Ensure clean environment first
      delete process.env.OPENAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;

      process.env.OLLAMA_ENDPOINT = 'http://localhost:11434';
      process.env.OLLAMA_MODEL = 'llama2';
      mockOs.homedir.mockReturnValue('/home/test');
      mockFs.existsSync.mockReturnValue(false);

      const config = loadConfig();

      expect(config.ai.provider).toBe('ollama');
      expect(config.ai.endpoint).toBe('http://localhost:11434');
      expect(config.ai.model).toBe('llama2');

      // Clean up immediately after this test
      delete process.env.OLLAMA_ENDPOINT;
      delete process.env.OLLAMA_MODEL;
    });
  });

  describe('validateConfig', () => {
    it('should validate OpenAI config', () => {
      const config = {
        ai: { provider: 'openai' as const, model: 'gpt-4o-mini' },
        watch: { patterns: ['**/*.ts'], debounceMs: 1000, ignore: ['node_modules/**'] },
        browser: { headless: true, timeout: 30000 },
      };

      const errors = validateConfig(config);
      expect(errors).toContain(
        'OpenAI API key is required. Set OPENAI_API_KEY environment variable or configure in ~/.iris/config.json',
      );
    });

    it('should validate Anthropic config', () => {
      const config = {
        ai: { provider: 'anthropic' as const, model: 'claude-3-haiku-20240307' },
        watch: { patterns: ['**/*.ts'], debounceMs: 1000, ignore: ['node_modules/**'] },
        browser: { headless: true, timeout: 30000 },
      };

      const errors = validateConfig(config);
      expect(errors).toContain(
        'Anthropic API key is required. Set ANTHROPIC_API_KEY environment variable or configure in ~/.iris/config.json',
      );
    });

    it('should validate Ollama config', () => {
      const config = {
        ai: { provider: 'ollama' as const, model: 'llama2' },
        watch: { patterns: ['**/*.ts'], debounceMs: 1000, ignore: ['node_modules/**'] },
        browser: { headless: true, timeout: 30000 },
      };

      const errors = validateConfig(config);
      expect(errors).toContain(
        'Ollama endpoint is required. Set OLLAMA_ENDPOINT environment variable or configure in ~/.iris/config.json',
      );
    });

    it('should validate timing constraints', () => {
      const config = {
        ai: { provider: 'openai' as const, apiKey: 'sk-test', model: 'gpt-4o-mini' },
        watch: { patterns: ['**/*.ts'], debounceMs: 50, ignore: ['node_modules/**'] },
        browser: { headless: true, timeout: 500 },
      };

      const errors = validateConfig(config);
      expect(errors).toContain('Watch debounce must be at least 100ms');
      expect(errors).toContain('Browser timeout must be at least 1000ms');
    });

    it('should pass valid config', () => {
      const config = {
        ai: { provider: 'openai' as const, apiKey: 'sk-test', model: 'gpt-4o-mini' },
        watch: { patterns: ['**/*.ts'], debounceMs: 1000, ignore: ['node_modules/**'] },
        browser: { headless: true, timeout: 30000 },
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
        browser: { headless: true, timeout: 30000 },
      };

      mockOs.homedir.mockReturnValue('/home/test');
      mockFs.existsSync.mockReturnValue(false);
      mockFs.mkdirSync.mockImplementation(() => undefined);
      mockFs.writeFileSync.mockImplementation(() => undefined);
      mockFs.chmodSync.mockImplementation(() => undefined);

      saveConfig(config);

      expect(mockFs.mkdirSync).toHaveBeenCalledWith('/home/test/.iris', {
        recursive: true,
        mode: 0o700,
      });
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        '/home/test/.iris/config.json',
        JSON.stringify(config, null, 2),
        { mode: 0o600 },
      );
      // File did not pre-exist, so no chmod is needed (writeFileSync's mode applies)
      expect(mockFs.chmodSync).not.toHaveBeenCalled();
    });

    it('tightens an existing config file before writing secrets', () => {
      const config = {
        ai: { provider: 'openai' as const, apiKey: 'sk-test', model: 'gpt-4o-mini' },
        watch: { patterns: ['**/*.ts'], debounceMs: 1000, ignore: ['node_modules/**'] },
        browser: { headless: true, timeout: 30000 },
      };

      mockOs.homedir.mockReturnValue('/home/test');
      // Dir exists + config file already exists (e.g. world-readable from an old version)
      mockFs.existsSync.mockReturnValue(true);
      mockFs.chmodSync.mockImplementation(() => undefined);
      mockFs.writeFileSync.mockImplementation(() => undefined);

      saveConfig(config);

      // chmod must run BEFORE the write so secrets never sit under loose perms
      const chmodOrder = mockFs.chmodSync.mock.invocationCallOrder[0];
      const writeOrder = mockFs.writeFileSync.mock.invocationCallOrder[0];
      expect(mockFs.chmodSync).toHaveBeenCalledWith('/home/test/.iris/config.json', 0o600);
      expect(chmodOrder).toBeLessThan(writeOrder);
    });

    // POSIX-only: verify the real on-disk file mode is 0o600 (owner-only).
    // Windows reports different mode bits, so skip there.
    const itPosix = process.platform === 'win32' ? it.skip : it;
    itPosix('writes config.json with 0o600 permissions on disk', () => {
      const realFs = jest.requireActual('fs') as typeof fs;
      const realOs = jest.requireActual('os') as typeof os;

      const tmpHome = realFs.mkdtempSync(path.join(realOs.tmpdir(), 'iris-cfg-'));
      try {
        // Point getConfigPath() at the temp home and route fs through the real module
        mockOs.homedir.mockReturnValue(tmpHome);
        mockFs.existsSync.mockImplementation(realFs.existsSync);
        mockFs.mkdirSync.mockImplementation(realFs.mkdirSync as typeof fs.mkdirSync);
        mockFs.writeFileSync.mockImplementation(realFs.writeFileSync as typeof fs.writeFileSync);
        mockFs.chmodSync.mockImplementation(realFs.chmodSync);

        const config = {
          ai: { provider: 'openai' as const, apiKey: 'sk-secret', model: 'gpt-4o-mini' },
          watch: { patterns: ['**/*.ts'], debounceMs: 1000, ignore: ['node_modules/**'] },
          browser: { headless: true, timeout: 30000 },
        };

        saveConfig(config);

        const configFile = path.join(tmpHome, '.iris', 'config.json');
        expect(realFs.statSync(configFile).mode & 0o777).toBe(0o600);
      } finally {
        realFs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });
  });
});

describe('loadDotenv', () => {
  const realFs = jest.requireActual('fs') as typeof fs;
  const realOs = jest.requireActual('os') as typeof os;
  let tmpDir: string;

  const TEST_KEYS = ['OPENAI_API_KEY', 'IRIS_DB_PATH', 'FROM_SHELL', 'QUOTED'];
  const clearKeys = () => TEST_KEYS.forEach((k) => delete process.env[k]);

  function writeEnv(contents: string): void {
    realFs.writeFileSync(path.join(tmpDir, '.env'), contents);
  }

  beforeEach(() => {
    tmpDir = realFs.mkdtempSync(path.join(realOs.tmpdir(), 'iris-env-'));
    // Route the globally-mocked fs.readFileSync to the real implementation so
    // loadDotenv reads the temp .env we just wrote.
    mockFs.readFileSync.mockImplementation(realFs.readFileSync as typeof fs.readFileSync);
    clearKeys();
  });

  afterEach(() => {
    realFs.rmSync(tmpDir, { recursive: true, force: true });
    clearKeys();
  });

  it('loads KEY=value pairs into process.env', () => {
    writeEnv('OPENAI_API_KEY=sk-from-file\nIRIS_DB_PATH=/tmp/iris.db\n');
    loadDotenv(tmpDir);
    expect(process.env.OPENAI_API_KEY).toBe('sk-from-file');
    expect(process.env.IRIS_DB_PATH).toBe('/tmp/iris.db');
  });

  it('does not override existing process.env values (shell wins)', () => {
    process.env.FROM_SHELL = 'real-value';
    writeEnv('FROM_SHELL=file-value\n');
    loadDotenv(tmpDir);
    expect(process.env.FROM_SHELL).toBe('real-value');
  });

  it('skips comments/blank lines and strips quotes and inline comments', () => {
    writeEnv('# a comment\n\nQUOTED="hello world"\nOPENAI_API_KEY=sk-abc   # inline note\n');
    loadDotenv(tmpDir);
    expect(process.env.QUOTED).toBe('hello world');
    expect(process.env.OPENAI_API_KEY).toBe('sk-abc');
  });

  it('handles the `export KEY=value` prefix', () => {
    writeEnv('export IRIS_DB_PATH=/data/iris.db\n');
    loadDotenv(tmpDir);
    expect(process.env.IRIS_DB_PATH).toBe('/data/iris.db');
  });

  it('is a no-op when no .env file exists', () => {
    expect(() => loadDotenv(tmpDir)).not.toThrow();
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
  });
});
