import { loadConfig, validateConfig, saveConfig, loadDotenv } from '../src/config';
import { DEFAULT_MODELS } from '../src/ai-client/models';
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
    delete process.env.OPENAI_MODEL;
    delete process.env.ANTHROPIC_MODEL;
  });

  afterEach(() => {
    // Additional cleanup after each test
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OLLAMA_ENDPOINT;
    delete process.env.OLLAMA_MODEL;
    delete process.env.OPENAI_MODEL;
    delete process.env.ANTHROPIC_MODEL;
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
      expect(config.ai.model).toBe('claude-haiku-4-5');
    });

    // Issue #74: the else-if chain picks one primary provider, and every other
    // key used to be discarded — leaving the fallback chain unable to
    // authenticate as any vendor but that one.
    it('keeps every credential present in the environment, not just the primary', () => {
      process.env.OPENAI_API_KEY = 'sk-openai';
      process.env.ANTHROPIC_API_KEY = 'sk-ant';
      process.env.OLLAMA_ENDPOINT = 'http://localhost:11434';
      mockOs.homedir.mockReturnValue('/home/test');
      mockFs.existsSync.mockReturnValue(false);

      const config = loadConfig();

      // Primary selection is unchanged: first match wins.
      expect(config.ai.provider).toBe('openai');
      expect(config.ai.apiKey).toBe('sk-openai');

      // ...but the others survive so the chain can reach them.
      expect(config.ai.credentials).toEqual({
        openai: { apiKey: 'sk-openai' },
        anthropic: { apiKey: 'sk-ant' },
        ollama: { endpoint: 'http://localhost:11434' },
      });
    });

    it('leaves credentials undefined when the environment has none', () => {
      delete process.env.OPENAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OLLAMA_ENDPOINT;
      mockOs.homedir.mockReturnValue('/home/test');
      mockFs.existsSync.mockReturnValue(false);

      expect(loadConfig().ai.credentials).toBeUndefined();
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

    // --- Issue #184: the file and environment layers used to be mutually
    // exclusive (`if (!exists) return loadFromEnvironment()`), which left no way
    // to express "key from the environment, model from the file" and silently
    // disabled every *_API_KEY the moment a config.json appeared.
    describe('layering (issue #184)', () => {
      /** Point loadConfig at a config.json with the given `ai` block. */
      const withConfigFile = (contents: object) => {
        mockOs.homedir.mockReturnValue('/home/test');
        mockFs.existsSync.mockReturnValue(true);
        mockFs.readFileSync.mockReturnValue(JSON.stringify(contents));
      };

      it('honours ai.model from the file while the API key comes from the environment', () => {
        process.env.ANTHROPIC_API_KEY = 'ant-from-env';
        withConfigFile({ ai: { provider: 'anthropic', model: 'claude-opus-5' } });

        const config = loadConfig();

        expect(config.ai.provider).toBe('anthropic');
        expect(config.ai.model).toBe('claude-opus-5');
        expect(config.ai.apiKey).toBe('ant-from-env');
      });

      it('no longer disables environment credentials just because a config file exists', () => {
        process.env.OPENAI_API_KEY = 'sk-from-env';
        process.env.ANTHROPIC_API_KEY = 'ant-from-env';
        withConfigFile({ watch: { debounceMs: 2000 } });

        const config = loadConfig();

        expect(config.ai.apiKey).toBe('sk-from-env');
        expect(config.ai.credentials).toEqual({
          openai: { apiKey: 'sk-from-env' },
          anthropic: { apiKey: 'ant-from-env' },
        });
        expect(config.watch.debounceMs).toBe(2000); // file values still apply
      });

      it('lets an explicit file provider outrank environment auto-detection', () => {
        // Auto-detection is a guess from credential presence; `ai.provider` in
        // the file is the user saying it outright, so the file wins.
        process.env.OPENAI_API_KEY = 'sk-from-env';
        process.env.ANTHROPIC_API_KEY = 'ant-from-env';
        withConfigFile({ ai: { provider: 'anthropic' } });

        const config = loadConfig();

        expect(config.ai.provider).toBe('anthropic');
        expect(config.ai.apiKey).toBe('ant-from-env'); // key matches the chosen provider
      });

      // Review finding (Critical): the file's top-level apiKey describes ONE
      // vendor. Handing it to whichever provider won resolution sent an OpenAI
      // key to Anthropic — the credential-crossing-vendors class of #74.
      it('never hands the file top-level apiKey to a provider it was not written for', () => {
        process.env.ANTHROPIC_API_KEY = 'sk-ant-new';
        withConfigFile({ ai: { apiKey: 'sk-openai-old' } }); // no provider named

        const config = loadConfig();

        expect(config.ai.provider).toBe('anthropic');
        expect(config.ai.apiKey).toBe('sk-ant-new');
        expect(config.ai.apiKey).not.toBe('sk-openai-old');
      });

      it('still uses the file top-level apiKey for the provider the file describes', () => {
        // No provider named + no env credential -> the file describes the
        // default provider, which is the classic single-provider config.
        withConfigFile({ ai: { apiKey: 'sk-openai-mine' } });

        const config = loadConfig();
        expect(config.ai.provider).toBe('openai');
        expect(config.ai.apiKey).toBe('sk-openai-mine');
      });

      it('does not hand the file top-level endpoint to another provider either', () => {
        process.env.ANTHROPIC_API_KEY = 'sk-ant-new';
        withConfigFile({ ai: { endpoint: 'http://my-openai-proxy' } });

        expect(loadConfig().ai.endpoint).toBeUndefined();
      });

      it('prefers a file apiKey over the environment for the configured provider', () => {
        process.env.ANTHROPIC_API_KEY = 'ant-from-env';
        withConfigFile({ ai: { provider: 'anthropic', apiKey: 'ant-from-file' } });

        expect(loadConfig().ai.apiKey).toBe('ant-from-file');
      });

      it('applies the built-in default for the RESOLVED provider, not for openai', () => {
        // The old env branch hardcoded the model inline; a file that names only
        // the provider must still get that provider's pin, never gpt-4o-mini.
        withConfigFile({ ai: { provider: 'anthropic' } });

        expect(loadConfig().ai.model).toBe(DEFAULT_MODELS.text.anthropic);
      });

      it('falls back to the file layer when the environment names no provider', () => {
        withConfigFile({ ai: { model: 'gpt-4' }, watch: { debounceMs: 2000 } });

        const config = loadConfig();
        expect(config.ai.provider).toBe('openai');
        expect(config.ai.model).toBe('gpt-4');
      });

      // Review finding: merging the credentials map one level too shallow let a
      // file entry replace a whole vendor's credential object rather than its
      // fields, silently dropping the other half.
      it('merges credentials per field, not per provider', () => {
        process.env.OLLAMA_ENDPOINT = 'http://localhost:11434';
        withConfigFile({ ai: { credentials: { ollama: { apiKey: 'proxy-token' } } } });

        expect(loadConfig().ai.credentials?.ollama).toEqual({
          endpoint: 'http://localhost:11434', // from env — must survive
          apiKey: 'proxy-token', // from file
        });
      });

      it('keeps a mixed-source credential usable for the active provider', () => {
        process.env.OLLAMA_ENDPOINT = 'http://localhost:11434';
        withConfigFile({
          ai: { provider: 'ollama', credentials: { ollama: { apiKey: 'proxy-token' } } },
        });

        const config = loadConfig();
        // Previously undefined, which surfaced as "Ollama endpoint not configured".
        expect(config.ai.endpoint).toBe('http://localhost:11434');
        expect(config.ai.apiKey).toBe('proxy-token');
      });

      it.each([
        ['null', 'null'],
        ['an array', '[1, 2]'],
        ['a bare string', '"nope"'],
      ])('ignores a config file containing %s', (_label, contents) => {
        // `null` parses fine, so only a shape check stops `file.ai` throwing.
        process.env.ANTHROPIC_API_KEY = 'ant-from-env';
        mockOs.homedir.mockReturnValue('/home/test');
        mockFs.existsSync.mockReturnValue(true);
        mockFs.readFileSync.mockReturnValue(contents);

        const config = loadConfig();
        expect(config.ai.provider).toBe('anthropic');
        expect(config.ai.apiKey).toBe('ant-from-env');
      });

      it('keeps the environment usable when the config file is unparseable', () => {
        // Previously a bad file fell back to loadFromEnvironment(), discarding
        // the file entirely; now the environment layer survives on its own.
        process.env.ANTHROPIC_API_KEY = 'ant-from-env';
        mockOs.homedir.mockReturnValue('/home/test');
        mockFs.existsSync.mockReturnValue(true);
        mockFs.readFileSync.mockReturnValue('{ not json');

        const config = loadConfig();

        expect(config.ai.provider).toBe('anthropic');
        expect(config.ai.apiKey).toBe('ant-from-env');
      });
    });

    describe('<PROVIDER>_MODEL overrides (issue #184)', () => {
      it('honours ANTHROPIC_MODEL over the built-in default', () => {
        process.env.ANTHROPIC_API_KEY = 'ant-test-key';
        process.env.ANTHROPIC_MODEL = 'claude-opus-5';
        mockOs.homedir.mockReturnValue('/home/test');
        mockFs.existsSync.mockReturnValue(false);

        expect(loadConfig().ai.model).toBe('claude-opus-5');
      });

      it('honours OPENAI_MODEL over the built-in default', () => {
        process.env.OPENAI_API_KEY = 'sk-test-key';
        process.env.OPENAI_MODEL = 'gpt-4o';
        mockOs.homedir.mockReturnValue('/home/test');
        mockFs.existsSync.mockReturnValue(false);

        expect(loadConfig().ai.model).toBe('gpt-4o');
      });

      it('lets the env model override the file model (env is the outer layer)', () => {
        process.env.ANTHROPIC_API_KEY = 'ant-test-key';
        process.env.ANTHROPIC_MODEL = 'claude-opus-5';
        mockOs.homedir.mockReturnValue('/home/test');
        mockFs.existsSync.mockReturnValue(true);
        mockFs.readFileSync.mockReturnValue(
          JSON.stringify({ ai: { provider: 'anthropic', model: 'claude-haiku-4-5' } }),
        );

        expect(loadConfig().ai.model).toBe('claude-opus-5');
      });

      it('ignores a model var belonging to a provider that is not active', () => {
        // OPENAI_MODEL must not leak into an Anthropic session.
        process.env.ANTHROPIC_API_KEY = 'ant-test-key';
        process.env.OPENAI_MODEL = 'gpt-4o';
        mockOs.homedir.mockReturnValue('/home/test');
        mockFs.existsSync.mockReturnValue(false);

        expect(loadConfig().ai.model).toBe(DEFAULT_MODELS.text.anthropic);
      });
    });

    it('should not leak env-driven state into subsequent loads (issue #63)', () => {
      mockOs.homedir.mockReturnValue('/home/test');
      mockFs.existsSync.mockReturnValue(false);

      process.env.ANTHROPIC_API_KEY = 'ant-test-key';
      const first = loadConfig();
      expect(first.ai.provider).toBe('anthropic');
      expect(first.ai.model).toBe('claude-haiku-4-5');

      delete process.env.ANTHROPIC_API_KEY;
      const second = loadConfig();

      expect(second.ai.provider).toBe('openai');
      expect(second.ai.model).toBe('gpt-4o-mini');
      expect(second.ai.apiKey).toBeUndefined();
      expect(second.ai).not.toBe(first.ai);
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
        ai: { provider: 'anthropic' as const, model: 'claude-haiku-4-5' },
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

  // Issue #185: `runCli()` calls `loadDotenv()` with no argument, so under Jest
  // it read the repo root and injected the developer's real keys mid-test. The
  // override is what lets the harness aim that default somewhere empty.
  describe('IRIS_DOTENV_DIR override (issue #185)', () => {
    let savedOverride: string | undefined;

    beforeEach(() => {
      savedOverride = process.env.IRIS_DOTENV_DIR;
    });

    afterEach(() => {
      if (savedOverride === undefined) delete process.env.IRIS_DOTENV_DIR;
      else process.env.IRIS_DOTENV_DIR = savedOverride;
      delete process.env.IRIS_DOTENV_DIR_PROBE;
    });

    it('reads from IRIS_DOTENV_DIR when called with no argument', () => {
      writeEnv('IRIS_DOTENV_DIR_PROBE=from-override\n');
      process.env.IRIS_DOTENV_DIR = tmpDir;

      loadDotenv(); // no argument — the call shape runCli() uses

      expect(process.env.IRIS_DOTENV_DIR_PROBE).toBe('from-override');
    });

    it('does not read process.cwd() when the override points elsewhere', () => {
      // cwd must actually CONTAIN a .env for this to prove anything. An earlier
      // version left cwd as the repo root and asserted no keys appeared — which
      // passes in CI whether or not the override works, since a fresh checkout
      // has no .env either. Stub cwd with a populated directory instead.
      const populatedCwd = realFs.mkdtempSync(path.join(realOs.tmpdir(), 'iris-env-cwd-'));
      const cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(populatedCwd);
      try {
        realFs.writeFileSync(
          path.join(populatedCwd, '.env'),
          'IRIS_DOTENV_DIR_PROBE=from-cwd\nOPENAI_API_KEY=sk-should-not-be-read\n',
        );
        process.env.IRIS_DOTENV_DIR = tmpDir; // deliberately has no .env
        expect(realFs.existsSync(path.join(tmpDir, '.env'))).toBe(false);

        loadDotenv();

        // Nothing from cwd's .env may appear.
        expect(process.env.IRIS_DOTENV_DIR_PROBE).toBeUndefined();
        expect(process.env.OPENAI_API_KEY).toBeUndefined();
      } finally {
        cwdSpy.mockRestore();
        realFs.rmSync(populatedCwd, { recursive: true, force: true });
      }
    });

    it('lets an explicit argument win over the override', () => {
      // Keeps the existing loadDotenv(tmpDir) cases above meaningful.
      const other = realFs.mkdtempSync(path.join(realOs.tmpdir(), 'iris-env-explicit-'));
      try {
        realFs.writeFileSync(path.join(other, '.env'), 'IRIS_DOTENV_DIR_PROBE=from-argument\n');
        writeEnv('IRIS_DOTENV_DIR_PROBE=from-override\n');
        process.env.IRIS_DOTENV_DIR = tmpDir;

        loadDotenv(other);

        expect(process.env.IRIS_DOTENV_DIR_PROBE).toBe('from-argument');
      } finally {
        realFs.rmSync(other, { recursive: true, force: true });
      }
    });

    it('falls back to process.cwd() when the override is unset', () => {
      // cwd is stubbed rather than left as the repo root ON PURPOSE. An earlier
      // draft of this test called loadDotenv() against the real working
      // directory to prove the fallback — which loaded the developer's actual
      // .env and injected a live API key into process.env, the exact defect
      // this file is testing. Never point the fallback at the real repo root.
      const other = realFs.mkdtempSync(path.join(realOs.tmpdir(), 'iris-env-cwd-'));
      const cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(other);
      try {
        realFs.writeFileSync(path.join(other, '.env'), 'IRIS_DOTENV_DIR_PROBE=from-cwd\n');
        delete process.env.IRIS_DOTENV_DIR;

        loadDotenv();

        expect(process.env.IRIS_DOTENV_DIR_PROBE).toBe('from-cwd');
      } finally {
        cwdSpy.mockRestore();
        realFs.rmSync(other, { recursive: true, force: true });
      }
    });
  });
});

// The guard only works if the harness actually installs it. Asserting the
// invariant here means deleting it from jest.setup.ts fails loudly rather than
// silently restoring issue #185.
describe('test harness hermeticity (issue #185)', () => {
  const realFs = jest.requireActual('fs') as typeof fs;
  const realOs = jest.requireActual('os') as typeof os;

  it('points loadDotenv at a real directory that is not the repo root', () => {
    const dir = process.env.IRIS_DOTENV_DIR;
    expect(dir).toBeTruthy();
    // Existence matters: a path that does not exist would also "contain no
    // .env", so the check below would pass for a guard pointing at nothing.
    expect(realFs.existsSync(dir as string)).toBe(true);
    expect(realFs.statSync(dir as string).isDirectory()).toBe(true);
    expect(path.resolve(dir as string)).not.toBe(path.resolve(process.cwd()));
  });

  it('points loadDotenv at a directory containing no .env', () => {
    const dir = process.env.IRIS_DOTENV_DIR as string;
    expect(realFs.existsSync(path.join(dir, '.env'))).toBe(false);
  });

  // Review finding: the first version used `?? process.env.IRIS_DOTENV_DIR`,
  // copying the idiom from the IRIS_DB_PATH guard above. Those guards honour an
  // ambient override on purpose; this one must not — an exported
  // IRIS_DOTENV_DIR aimed at a real project is the leak, not a preference.
  it('uses a harness-owned directory even if one was exported into the environment', () => {
    const dir = process.env.IRIS_DOTENV_DIR as string;
    expect(path.dirname(dir)).toBe(realOs.tmpdir());
    expect(path.basename(dir)).toMatch(/^iris-jest-no-dotenv-/);
  });

  // Deliberately NOT asserting here that process.env starts free of provider
  // credentials: this file's own beforeEach already deletes them, so the
  // assertion would pass whether or not the harness scrub exists. That property
  // is checked in cli.test.ts, which does not scrub — verified by disabling the
  // guard and watching it fail.
});
