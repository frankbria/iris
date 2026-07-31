/**
 * Integration tests for visual-diff CLI command
 */

type MockedAiConfig = {
  provider: 'openai' | 'anthropic' | 'ollama';
  apiKey?: string;
  model?: string;
  endpoint?: string;
  credentials?: Partial<
    Record<'openai' | 'anthropic' | 'ollama', { apiKey?: string; endpoint?: string }>
  >;
};

/**
 * Stub `src/config` so provider/key resolution is deterministic.
 *
 * The real `loadConfig()` reads `~/.iris/config.json` and `loadDotenv()` reads
 * the repo's `.env` — either could inject a developer's real API key and flip
 * the assertions below depending on whose machine runs the suite.
 */
function mockIrisConfig(ai: MockedAiConfig): void {
  jest.doMock('../src/config', () => ({
    loadDotenv: jest.fn(),
    loadConfig: jest.fn(() => ({
      ai: { model: 'gpt-4o-mini', ...ai },
      watch: { patterns: [], debounceMs: 1000, ignore: [] },
      browser: { headless: true, timeout: 30000 },
    })),
  }));
}

describe('visual-diff CLI command', () => {
  // Mock console methods to capture output
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  describe('command registration', () => {
    it('should register visual-diff command without errors', async () => {
      // Mock the VisualTestRunner to avoid actual browser operations
      jest.doMock('../src/visual/visual-runner', () => ({
        VisualTestRunner: jest.fn().mockImplementation(() => ({
          run: jest.fn().mockResolvedValue({
            summary: {
              totalComparisons: 1,
              passed: 1,
              failed: 0,
              newBaselines: 0,
              overallStatus: 'passed',
              severityCounts: {
                breaking: 0,
                moderate: 0,
                minor: 0,
              },
            },
            results: [],
            reportPath: undefined,
            duration: 1000,
          }),
        })),
      }));

      jest.resetModules();
      const { runCli: freshRunCli } = await import('../src/cli');

      // Run command without help flag - should execute successfully
      await freshRunCli(['node', 'iris', 'visual-diff', '--pages', '/']);

      // Verify command executed (output captured)
      const output = consoleLogSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(output).toContain('Starting visual regression testing');
    });

    it('should execute visual-diff command with valid options', async () => {
      const mockRun = jest.fn().mockResolvedValue({
        summary: {
          totalComparisons: 1,
          passed: 1,
          failed: 0,
          newBaselines: 0,
          overallStatus: 'passed',
          severityCounts: {},
        },
        results: [],
        duration: 1000,
      });

      jest.doMock('../src/visual/visual-runner', () => ({
        VisualTestRunner: jest.fn().mockImplementation((config) => {
          // Verify all expected options are present
          expect(config.pages).toBeDefined();
          expect(config.baseline).toBeDefined();
          expect(config.diff.threshold).toBeDefined();
          expect(config.diff.semanticAnalysis).toBeDefined();
          expect(config.devices).toBeDefined();
          expect(config.output).toBeDefined();
          return { run: mockRun };
        }),
      }));

      jest.resetModules();
      const { runCli: freshRunCli } = await import('../src/cli');

      await freshRunCli(['node', 'iris', 'visual-diff']);

      expect(mockRun).toHaveBeenCalled();
    });
  });

  describe('command execution', () => {
    it('should parse pages option correctly', async () => {
      const mockRun = jest.fn().mockResolvedValue({
        summary: {
          totalComparisons: 3,
          passed: 3,
          failed: 0,
          newBaselines: 0,
          overallStatus: 'passed',
          severityCounts: {},
        },
        results: [],
        duration: 1000,
      });

      // Mock implementation
      jest.doMock('../src/visual/visual-runner', () => ({
        VisualTestRunner: jest.fn().mockImplementation((config) => {
          // Verify pages are parsed correctly
          expect(config.pages).toEqual(['/', '/about', '/contact']);
          return { run: mockRun };
        }),
      }));

      // Need to clear module cache and re-import
      jest.resetModules();
      const { runCli: freshRunCli } = await import('../src/cli');

      await freshRunCli(['node', 'iris', 'visual-diff', '--pages', '/,/about,/contact']);

      expect(mockRun).toHaveBeenCalled();
    });

    it('should handle baseline option', async () => {
      const mockRun = jest.fn().mockResolvedValue({
        summary: {
          totalComparisons: 1,
          passed: 1,
          failed: 0,
          newBaselines: 0,
          overallStatus: 'passed',
          severityCounts: {},
        },
        results: [],
        duration: 1000,
      });

      jest.doMock('../src/visual/visual-runner', () => ({
        VisualTestRunner: jest.fn().mockImplementation((config) => {
          expect(config.baseline.reference).toBe('develop');
          return { run: mockRun };
        }),
      }));

      jest.resetModules();
      const { runCli: freshRunCli } = await import('../src/cli');

      await freshRunCli(['node', 'iris', 'visual-diff', '--baseline', 'develop']);

      expect(mockRun).toHaveBeenCalled();
    });

    it('should pass --base-url through to the runner config', async () => {
      const mockRun = jest.fn().mockResolvedValue({
        summary: {
          totalComparisons: 1,
          passed: 1,
          failed: 0,
          newBaselines: 0,
          overallStatus: 'passed',
          severityCounts: {},
        },
        results: [],
        duration: 1000,
      });

      jest.doMock('../src/visual/visual-runner', () => ({
        VisualTestRunner: jest.fn().mockImplementation((config) => {
          expect(config.baseURL).toBe('https://staging.example.com');
          return { run: mockRun };
        }),
      }));

      jest.resetModules();
      const { runCli: freshRunCli } = await import('../src/cli');

      await freshRunCli([
        'node',
        'iris',
        'visual-diff',
        '--base-url',
        'https://staging.example.com',
      ]);

      expect(mockRun).toHaveBeenCalled();
    });

    it('should use IRIS_BASE_URL when --base-url is absent, with the flag taking precedence', async () => {
      const originalEnv = process.env.IRIS_BASE_URL;
      process.env.IRIS_BASE_URL = 'https://env.example.com';

      try {
        const mockRun = jest.fn().mockResolvedValue({
          summary: {
            totalComparisons: 1,
            passed: 1,
            failed: 0,
            newBaselines: 0,
            overallStatus: 'passed',
            severityCounts: {},
          },
          results: [],
          duration: 1000,
        });

        // Env var alone populates baseURL.
        jest.doMock('../src/visual/visual-runner', () => ({
          VisualTestRunner: jest.fn().mockImplementation((config) => {
            expect(config.baseURL).toBe('https://env.example.com');
            return { run: mockRun };
          }),
        }));

        jest.resetModules();
        const { runCli: envRunCli } = await import('../src/cli');
        await envRunCli(['node', 'iris', 'visual-diff']);
        expect(mockRun).toHaveBeenCalled();

        // Flag overrides env var.
        jest.resetModules();
        jest.doMock('../src/visual/visual-runner', () => ({
          VisualTestRunner: jest.fn().mockImplementation((config) => {
            expect(config.baseURL).toBe('https://flag.example.com');
            return { run: mockRun };
          }),
        }));
        const { runCli: flagRunCli } = await import('../src/cli');
        await flagRunCli(['node', 'iris', 'visual-diff', '--base-url', 'https://flag.example.com']);
        expect(mockRun).toHaveBeenCalledTimes(2);
      } finally {
        if (originalEnv === undefined) {
          delete process.env.IRIS_BASE_URL;
        } else {
          process.env.IRIS_BASE_URL = originalEnv;
        }
      }
    });

    it('should enable semantic analysis when flag is set', async () => {
      const mockRun = jest.fn().mockResolvedValue({
        summary: {
          totalComparisons: 1,
          passed: 1,
          failed: 0,
          newBaselines: 0,
          overallStatus: 'passed',
          severityCounts: {},
        },
        results: [],
        duration: 1000,
      });

      // --semantic now requires resolvable credentials, so stub the config
      // resolution rather than depending on the developer's environment.
      mockIrisConfig({ provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o' });

      jest.doMock('../src/visual/visual-runner', () => ({
        VisualTestRunner: jest.fn().mockImplementation((config) => {
          expect(config.diff.semanticAnalysis).toBe(true);
          return { run: mockRun };
        }),
      }));

      jest.resetModules();
      const { runCli: freshRunCli } = await import('../src/cli');

      await freshRunCli(['node', 'iris', 'visual-diff', '--semantic']);

      expect(mockRun).toHaveBeenCalled();
    });

    it('should parse threshold option', async () => {
      const mockRun = jest.fn().mockResolvedValue({
        summary: {
          totalComparisons: 1,
          passed: 1,
          failed: 0,
          newBaselines: 0,
          overallStatus: 'passed',
          severityCounts: {},
        },
        results: [],
        duration: 1000,
      });

      jest.doMock('../src/visual/visual-runner', () => ({
        VisualTestRunner: jest.fn().mockImplementation((config) => {
          expect(config.diff.threshold).toBe(0.15);
          return { run: mockRun };
        }),
      }));

      jest.resetModules();
      const { runCli: freshRunCli } = await import('../src/cli');

      await freshRunCli(['node', 'iris', 'visual-diff', '--threshold', '0.15']);

      expect(mockRun).toHaveBeenCalled();
    });
  });

  describe('exit codes', () => {
    it('should exit with 0 when all tests pass', async () => {
      jest.doMock('../src/visual/visual-runner', () => ({
        VisualTestRunner: jest.fn().mockImplementation(() => ({
          run: jest.fn().mockResolvedValue({
            summary: {
              totalComparisons: 1,
              passed: 1,
              failed: 0,
              newBaselines: 0,
              overallStatus: 'passed',
              severityCounts: {},
            },
            results: [],
            duration: 1000,
          }),
        })),
      }));

      jest.resetModules();
      const { runCli: freshRunCli } = await import('../src/cli');

      await freshRunCli(['node', 'iris', 'visual-diff']);

      // Should not call process.exit for success
      expect(processExitSpy).not.toHaveBeenCalled();
    });

    it('should exit with 5 when visual regression detected with breaking severity', async () => {
      jest.doMock('../src/visual/visual-runner', () => ({
        VisualTestRunner: jest.fn().mockImplementation(() => ({
          run: jest.fn().mockResolvedValue({
            summary: {
              totalComparisons: 1,
              passed: 0,
              failed: 1,
              newBaselines: 0,
              overallStatus: 'failed',
              severityCounts: {
                breaking: 1,
                moderate: 0,
                minor: 0,
              },
            },
            results: [],
            duration: 1000,
          }),
        })),
      }));

      jest.resetModules();
      const { runCli: freshRunCli } = await import('../src/cli');

      try {
        await freshRunCli(['node', 'iris', 'visual-diff', '--fail-on', 'breaking']);
      } catch {
        // Expected to throw due to process.exit mock
      }

      expect(processExitSpy).toHaveBeenCalledWith(5);
    });

    it('should still exit 5 for a mis-cased/whitespace --fail-on value with a breaking regression', async () => {
      // Regression for #56: " Breaking " must normalize (trim + lowercase) and
      // still trigger the failure exit code, not silently pass via indexOf(-1).
      jest.doMock('../src/visual/visual-runner', () => ({
        VisualTestRunner: jest.fn().mockImplementation(() => ({
          run: jest.fn().mockResolvedValue({
            summary: {
              totalComparisons: 1,
              passed: 0,
              failed: 1,
              newBaselines: 0,
              overallStatus: 'failed',
              severityCounts: { breaking: 1, moderate: 0, minor: 0 },
            },
            results: [],
            duration: 1000,
          }),
        })),
      }));

      jest.resetModules();
      const { runCli: freshRunCli } = await import('../src/cli');

      try {
        await freshRunCli(['node', 'iris', 'visual-diff', '--fail-on', ' Breaking ']);
      } catch {
        // Expected to throw due to process.exit mock
      }

      expect(processExitSpy).toHaveBeenCalledWith(5);
    });

    it('should reject an invalid --fail-on value with a non-zero exit instead of passing', async () => {
      // Regression for #56: a genuinely invalid value must fail validation, not
      // slip through and exit 0 while regressions exist.
      jest.doMock('../src/visual/visual-runner', () => ({
        VisualTestRunner: jest.fn().mockImplementation(() => ({
          run: jest.fn().mockResolvedValue({
            summary: {
              totalComparisons: 1,
              passed: 0,
              failed: 1,
              newBaselines: 0,
              overallStatus: 'failed',
              severityCounts: { breaking: 1, moderate: 0, minor: 0 },
            },
            results: [],
            duration: 1000,
          }),
        })),
      }));

      jest.resetModules();
      const { runCli: freshRunCli } = await import('../src/cli');

      try {
        await freshRunCli(['node', 'iris', 'visual-diff', '--fail-on', 'catastrophic']);
      } catch {
        // Expected to throw: commander exits non-zero on InvalidArgumentError
      }

      // Never exit 0; commander rejects the bad value before the runner runs.
      expect(processExitSpy).not.toHaveBeenCalledWith(0);
      expect(processExitSpy).toHaveBeenCalled();
    });

    it('should exit with 3 when command execution fails', async () => {
      jest.doMock('../src/visual/visual-runner', () => ({
        VisualTestRunner: jest.fn().mockImplementation(() => ({
          run: jest.fn().mockRejectedValue(new Error('Browser launch failed')),
        })),
      }));

      jest.resetModules();
      const { runCli: freshRunCli } = await import('../src/cli');

      try {
        await freshRunCli(['node', 'iris', 'visual-diff']);
      } catch {
        // Expected to throw
      }

      expect(processExitSpy).toHaveBeenCalledWith(3);
    });
  });

  describe('output reporting', () => {
    it('should display summary statistics', async () => {
      jest.doMock('../src/visual/visual-runner', () => ({
        VisualTestRunner: jest.fn().mockImplementation(() => ({
          run: jest.fn().mockResolvedValue({
            summary: {
              totalComparisons: 5,
              passed: 3,
              failed: 2,
              newBaselines: 1,
              overallStatus: 'failed',
              severityCounts: {
                breaking: 1,
                moderate: 1,
                minor: 0,
              },
            },
            results: [],
            reportPath: '/path/to/report.html',
            duration: 2500,
          }),
        })),
      }));

      jest.resetModules();
      const { runCli: freshRunCli } = await import('../src/cli');

      try {
        await freshRunCli(['node', 'iris', 'visual-diff', '--format', 'html']);
      } catch {
        // May throw due to exit
      }

      const output = consoleLogSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(output).toContain('Total comparisons: 5');
      expect(output).toContain('Passed: 3');
      expect(output).toContain('Failed: 2');
      expect(output).toContain('Breaking: 1');
      expect(output).toContain('Moderate: 1');
    });

    it('should display report path when generated', async () => {
      const reportPath = '/tmp/visual-report.html';

      jest.doMock('../src/visual/visual-runner', () => ({
        VisualTestRunner: jest.fn().mockImplementation(() => ({
          run: jest.fn().mockResolvedValue({
            summary: {
              totalComparisons: 1,
              passed: 0,
              failed: 1,
              newBaselines: 0,
              overallStatus: 'failed',
              severityCounts: { breaking: 1 },
            },
            results: [],
            reportPath,
            duration: 1000,
          }),
        })),
      }));

      jest.resetModules();
      const { runCli: freshRunCli } = await import('../src/cli');

      try {
        await freshRunCli(['node', 'iris', 'visual-diff', '--format', 'html']);
      } catch {
        // May throw
      }

      const output = consoleLogSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(output).toContain(`Report generated: ${reportPath}`);
    });
  });

  describe('configuration validation', () => {
    it('should handle mask selectors', async () => {
      const mockRun = jest.fn().mockResolvedValue({
        summary: {
          totalComparisons: 1,
          passed: 1,
          failed: 0,
          newBaselines: 0,
          overallStatus: 'passed',
          severityCounts: {},
        },
        results: [],
        duration: 1000,
      });

      jest.doMock('../src/visual/visual-runner', () => ({
        VisualTestRunner: jest.fn().mockImplementation((config) => {
          expect(config.capture.mask).toEqual(['.ad', '.popup', '.timestamp']);
          return { run: mockRun };
        }),
      }));

      jest.resetModules();
      const { runCli: freshRunCli } = await import('../src/cli');

      await freshRunCli(['node', 'iris', 'visual-diff', '--mask', '.ad,.popup,.timestamp']);

      expect(mockRun).toHaveBeenCalled();
    });

    it('should handle multiple devices', async () => {
      const mockRun = jest.fn().mockResolvedValue({
        summary: {
          totalComparisons: 3,
          passed: 3,
          failed: 0,
          newBaselines: 0,
          overallStatus: 'passed',
          severityCounts: {},
        },
        results: [],
        duration: 3000,
      });

      jest.doMock('../src/visual/visual-runner', () => ({
        VisualTestRunner: jest.fn().mockImplementation((config) => {
          expect(config.devices).toEqual(['desktop', 'mobile', 'tablet']);
          return { run: mockRun };
        }),
      }));

      jest.resetModules();
      const { runCli: freshRunCli } = await import('../src/cli');

      await freshRunCli(['node', 'iris', 'visual-diff', '--devices', 'desktop,mobile,tablet']);

      expect(mockRun).toHaveBeenCalled();
    });

    it('should handle update-baseline flag', async () => {
      const mockRun = jest.fn().mockResolvedValue({
        summary: {
          totalComparisons: 1,
          passed: 1,
          failed: 0,
          newBaselines: 1,
          overallStatus: 'passed',
          severityCounts: {},
        },
        results: [],
        duration: 1000,
      });

      jest.doMock('../src/visual/visual-runner', () => ({
        VisualTestRunner: jest.fn().mockImplementation((config) => {
          expect(config.updateBaseline).toBe(true);
          return { run: mockRun };
        }),
      }));

      jest.resetModules();
      const { runCli: freshRunCli } = await import('../src/cli');

      await freshRunCli(['node', 'iris', 'visual-diff', '--update-baseline']);

      expect(mockRun).toHaveBeenCalled();
    });
  });

  // Issue #111: --semantic crashed 100% of the time because the CLI hardcoded
  // `aiProvider: 'openai'` and never plumbed an API key, so the classifier's
  // constructor guard threw before any comparison ran.
  describe('--semantic provider wiring', () => {
    const CREDENTIAL_VARS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OLLAMA_ENDPOINT'] as const;
    let savedEnv: Record<string, string | undefined>;

    beforeEach(() => {
      savedEnv = {};
      for (const key of CREDENTIAL_VARS) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
      }
    });

    afterEach(() => {
      for (const key of CREDENTIAL_VARS) {
        if (savedEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = savedEnv[key];
        }
      }
    });

    /** Run visual-diff against a mocked runner; returns the runner constructor spy. */
    async function runVisualDiff(args: string[]): Promise<jest.Mock> {
      const runnerCtor = jest.fn().mockImplementation(() => ({
        run: jest.fn().mockResolvedValue({
          summary: {
            totalComparisons: 1,
            passed: 1,
            failed: 0,
            newBaselines: 0,
            overallStatus: 'passed',
            severityCounts: {},
          },
          results: [],
          duration: 1000,
        }),
      }));

      jest.doMock('../src/visual/visual-runner', () => ({ VisualTestRunner: runnerCtor }));
      jest.resetModules();
      const { runCli: freshRunCli } = await import('../src/cli');

      try {
        await freshRunCli(['node', 'iris', 'visual-diff', ...args]);
      } catch {
        // The process.exit spy throws; guarded paths land here by design.
      }

      return runnerCtor;
    }

    const diffConfigOf = (runnerCtor: jest.Mock) => runnerCtor.mock.calls[0][0].diff;
    const errorOutput = () => consoleErrorSpy.mock.calls.map((call) => call.join(' ')).join('\n');

    it('auto-detects provider and key from the environment', async () => {
      // The stubbed config carries NO key, so a passing assertion can only mean
      // the key was sourced from the environment.
      process.env.OPENAI_API_KEY = 'sk-env-openai';
      mockIrisConfig({ provider: 'openai' });

      const runnerCtor = await runVisualDiff(['--semantic']);

      expect(runnerCtor).toHaveBeenCalledTimes(1);
      expect(diffConfigOf(runnerCtor)).toMatchObject({
        semanticAnalysis: true,
        aiProvider: 'openai',
        apiKey: 'sk-env-openai',
      });
    });

    // Issue #74: the credentials map has to survive the whole path
    // CLI -> VisualTestRunner -> AIVisualClassifier -> SmartAIVisionClient, or
    // the fallback chain still cannot authenticate as a second vendor.
    it('forwards the per-provider credentials map to the runner', async () => {
      process.env.OPENAI_API_KEY = 'sk-env-openai';
      process.env.ANTHROPIC_API_KEY = 'sk-env-ant';
      mockIrisConfig({
        provider: 'openai',
        credentials: {
          openai: { apiKey: 'sk-env-openai' },
          anthropic: { apiKey: 'sk-env-ant' },
        },
      });

      const runnerCtor = await runVisualDiff(['--semantic']);

      expect(diffConfigOf(runnerCtor).aiCredentials).toEqual({
        openai: { apiKey: 'sk-env-openai' },
        anthropic: { apiKey: 'sk-env-ant' },
      });
    });

    it('leaves aiCredentials undefined when the config has none', async () => {
      process.env.OPENAI_API_KEY = 'sk-env-openai';
      mockIrisConfig({ provider: 'openai' });

      const runnerCtor = await runVisualDiff(['--semantic']);

      expect(diffConfigOf(runnerCtor).aiCredentials).toBeUndefined();
    });

    it('prefers the config-file key over the environment for the same provider', async () => {
      process.env.OPENAI_API_KEY = 'sk-env-openai';
      mockIrisConfig({ provider: 'openai', apiKey: 'sk-config-openai' });

      const runnerCtor = await runVisualDiff(['--semantic']);

      expect(diffConfigOf(runnerCtor).apiKey).toBe('sk-config-openai');
    });

    // Review finding (Minor-1): loadConfig() only auto-detects from env when no
    // ~/.iris/config.json exists, and its fallback provider is a keyless
    // 'openai'. Without detectProvider() this told Anthropic-only users to set
    // OPENAI_API_KEY.
    it('falls back to the environment when the configured provider has no key', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
      mockIrisConfig({ provider: 'openai' }); // config file present, keyless default

      const runnerCtor = await runVisualDiff(['--semantic']);

      expect(processExitSpy).not.toHaveBeenCalled();
      expect(diffConfigOf(runnerCtor)).toMatchObject({
        aiProvider: 'claude',
        apiKey: 'sk-ant-env',
      });
    });

    it('maps --provider anthropic onto the classifier\'s "claude" vocabulary', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
      mockIrisConfig({ provider: 'anthropic', apiKey: 'sk-ant-test' });

      const runnerCtor = await runVisualDiff(['--semantic', '--provider', 'anthropic']);

      expect(diffConfigOf(runnerCtor)).toMatchObject({
        aiProvider: 'claude',
        apiKey: 'sk-ant-test',
      });
    });

    it('never hands an OpenAI key to Anthropic when --provider overrides the environment', async () => {
      process.env.OPENAI_API_KEY = 'sk-openai-only';
      mockIrisConfig({ provider: 'openai', apiKey: 'sk-openai-only' });

      const runnerCtor = await runVisualDiff(['--semantic', '--provider', 'anthropic']);

      expect(runnerCtor).not.toHaveBeenCalled();
      expect(processExitSpy).toHaveBeenCalledWith(2);
      expect(errorOutput()).toContain('ANTHROPIC_API_KEY');
    });

    it('allows --provider ollama with no API keys configured', async () => {
      mockIrisConfig({ provider: 'openai' });

      const runnerCtor = await runVisualDiff(['--semantic', '--provider', 'ollama']);

      expect(processExitSpy).not.toHaveBeenCalled();
      expect(diffConfigOf(runnerCtor)).toMatchObject({
        aiProvider: 'ollama',
        aiEndpoint: 'http://localhost:11434',
      });
      expect(diffConfigOf(runnerCtor).apiKey).toBeUndefined();
    });

    it('uses the configured Ollama endpoint when one is set', async () => {
      mockIrisConfig({ provider: 'ollama', endpoint: 'http://ollama.internal:11434' });

      const runnerCtor = await runVisualDiff(['--semantic']);

      expect(diffConfigOf(runnerCtor)).toMatchObject({
        aiProvider: 'ollama',
        aiEndpoint: 'http://ollama.internal:11434',
      });
    });

    it('exits 2 with actionable guidance when no API key can be resolved', async () => {
      mockIrisConfig({ provider: 'openai' });

      const runnerCtor = await runVisualDiff(['--semantic']);

      // The guard must fire before the runner is built — the constructor throw
      // is not an acceptable error message for the user.
      expect(runnerCtor).not.toHaveBeenCalled();
      expect(processExitSpy).toHaveBeenCalledWith(2);
      const output = errorOutput();
      expect(output).toContain('OPENAI_API_KEY');
      expect(output).toContain('--provider ollama');
    });

    it('does not require credentials when --semantic is absent', async () => {
      mockIrisConfig({ provider: 'openai' });

      const runnerCtor = await runVisualDiff([]);

      expect(processExitSpy).not.toHaveBeenCalled();
      expect(diffConfigOf(runnerCtor)).toMatchObject({ semanticAnalysis: false });
      expect(diffConfigOf(runnerCtor).apiKey).toBeUndefined();
    });

    // Review finding (Minor-3): the CLI suite mocks VisualTestRunner and the
    // runner suite mocks AIVisualClassifier, so nothing proved the CLI's mapped
    // provider string actually survives the classifier's real validation.
    it('emits a provider value the real AIVisualClassifier accepts', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
      mockIrisConfig({ provider: 'anthropic', apiKey: 'sk-ant-test' });
      // Automock the smart client so the real constructor validates config
      // without opening SQLite or reaching the network.
      jest.doMock('../src/ai-client/smart-client');

      const runnerCtor = await runVisualDiff(['--semantic', '--provider', 'anthropic']);
      const { aiProvider, apiKey } = diffConfigOf(runnerCtor);

      const { AIVisualClassifier } = await import('../src/visual/ai-classifier');
      expect(() => new AIVisualClassifier({ provider: aiProvider, apiKey })).not.toThrow();
    });

    it('rejects an unknown --provider value', async () => {
      mockIrisConfig({ provider: 'openai', apiKey: 'sk-test' });

      const runnerCtor = await runVisualDiff(['--semantic', '--provider', 'gemini']);

      expect(runnerCtor).not.toHaveBeenCalled();
      expect(processExitSpy).toHaveBeenCalled();
      expect(processExitSpy).not.toHaveBeenCalledWith(0);
    });
  });
});
