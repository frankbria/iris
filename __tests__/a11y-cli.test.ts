/**
 * Integration tests for the `a11y` CLI command glue (cli.ts:331-426).
 *
 * The AccessibilityRunner itself is covered elsewhere; these tests exercise the
 * thin CLI layer: option parsing/mapping, the failureThreshold reduce, exit
 * codes (0/3/4), and the HTML report-path conditional. AccessibilityRunner is
 * mocked so no browser is launched.
 */

describe('a11y CLI command', () => {
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let processExitSpy: jest.SpyInstance;

  // A passing summary the runner mock returns by default.
  const passingResult = {
    summary: {
      totalViolations: 0,
      score: 100,
      passed: true,
      violationsBySeverity: { critical: 0, serious: 0, moderate: 0, minor: 0 },
    },
    results: [],
    reportPath: undefined,
    duration: 1000,
  };

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
    delete process.env.IRIS_BASE_URL;
  });

  describe('option mapping', () => {
    it('maps default options into the runner config', async () => {
      const mockRun = jest.fn().mockResolvedValue(passingResult);

      jest.doMock('../src/a11y/a11y-runner', () => ({
        AccessibilityRunner: jest.fn().mockImplementation((config) => {
          // Defaults from the command definition.
          expect(config.pages).toEqual(['/']);
          expect(config.axe.tags).toEqual(['wcag2a', 'wcag2aa']);
          expect(config.failureThreshold).toEqual({ critical: true, serious: true });
          expect(config.output.format).toBe('html');
          expect(config.output.path).toBeUndefined();
          return { run: mockRun };
        }),
      }));

      jest.resetModules();
      const { runCli } = await import('../src/cli');
      await runCli(['node', 'iris', 'a11y']);

      expect(mockRun).toHaveBeenCalled();
    });

    it('parses --pages, --tags, and --fail-on into the runner config', async () => {
      const mockRun = jest.fn().mockResolvedValue(passingResult);

      jest.doMock('../src/a11y/a11y-runner', () => ({
        AccessibilityRunner: jest.fn().mockImplementation((config) => {
          expect(config.pages).toEqual(['/', '/about', '/contact']);
          expect(config.axe.tags).toEqual(['wcag2a', 'wcag2aa', 'wcag21aa']);
          // failureThreshold is built by reducing the comma list into a bool map.
          expect(config.failureThreshold).toEqual({ critical: true, moderate: true });
          return { run: mockRun };
        }),
      }));

      jest.resetModules();
      const { runCli } = await import('../src/cli');
      await runCli([
        'node',
        'iris',
        'a11y',
        '--pages',
        '/,/about,/contact',
        '--tags',
        'wcag2a,wcag2aa,wcag21aa',
        '--fail-on',
        'critical,moderate',
      ]);

      expect(mockRun).toHaveBeenCalled();
    });

    it('passes --base-url through, falling back to IRIS_BASE_URL', async () => {
      const mockRun = jest.fn().mockResolvedValue(passingResult);

      // Flag wins over env.
      process.env.IRIS_BASE_URL = 'https://env.example.com';
      jest.doMock('../src/a11y/a11y-runner', () => ({
        AccessibilityRunner: jest.fn().mockImplementation((config) => {
          expect(config.baseURL).toBe('https://flag.example.com');
          return { run: mockRun };
        }),
      }));

      jest.resetModules();
      const { runCli: flagCli } = await import('../src/cli');
      await flagCli(['node', 'iris', 'a11y', '--base-url', 'https://flag.example.com']);
      expect(mockRun).toHaveBeenCalled();

      // Env used when flag absent.
      jest.resetModules();
      jest.doMock('../src/a11y/a11y-runner', () => ({
        AccessibilityRunner: jest.fn().mockImplementation((config) => {
          expect(config.baseURL).toBe('https://env.example.com');
          return { run: mockRun };
        }),
      }));
      const { runCli: envCli } = await import('../src/cli');
      await envCli(['node', 'iris', 'a11y']);
      expect(mockRun).toHaveBeenCalledTimes(2);
    });

    it('maps screenreader/keyboard toggles', async () => {
      const mockRun = jest.fn().mockResolvedValue(passingResult);

      jest.doMock('../src/a11y/a11y-runner', () => ({
        AccessibilityRunner: jest.fn().mockImplementation((config) => {
          // --include-screenreader turns on the screen-reader checks.
          expect(config.screenReader.testImageAltText).toBe(true);
          expect(config.screenReader.simulateScreenReader).toBe(true);
          return { run: mockRun };
        }),
      }));

      jest.resetModules();
      const { runCli } = await import('../src/cli');
      await runCli(['node', 'iris', 'a11y', '--include-screenreader']);

      expect(mockRun).toHaveBeenCalled();
    });
  });

  describe('exit codes', () => {
    it('does not call process.exit when all tests pass (exit 0)', async () => {
      jest.doMock('../src/a11y/a11y-runner', () => ({
        AccessibilityRunner: jest.fn().mockImplementation(() => ({
          run: jest.fn().mockResolvedValue(passingResult),
        })),
      }));

      jest.resetModules();
      const { runCli } = await import('../src/cli');
      await runCli(['node', 'iris', 'a11y']);

      expect(processExitSpy).not.toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(output).toContain('All accessibility tests passed');
    });

    it('exits with 4 when violations are found', async () => {
      jest.doMock('../src/a11y/a11y-runner', () => ({
        AccessibilityRunner: jest.fn().mockImplementation(() => ({
          run: jest.fn().mockResolvedValue({
            summary: {
              totalViolations: 3,
              score: 70,
              passed: false,
              violationsBySeverity: { critical: 1, serious: 2, moderate: 0, minor: 0 },
            },
            results: [],
            duration: 1000,
          }),
        })),
      }));

      jest.resetModules();
      const { runCli } = await import('../src/cli');
      try {
        await runCli(['node', 'iris', 'a11y']);
      } catch {
        // process.exit mock throws
      }

      expect(processExitSpy).toHaveBeenCalledWith(4);
    });

    it('exits with 3 when the runner throws', async () => {
      jest.doMock('../src/a11y/a11y-runner', () => ({
        AccessibilityRunner: jest.fn().mockImplementation(() => ({
          run: jest.fn().mockRejectedValue(new Error('browser launch failed')),
        })),
      }));

      jest.resetModules();
      const { runCli } = await import('../src/cli');
      try {
        await runCli(['node', 'iris', 'a11y']);
      } catch {
        // process.exit mock throws
      }

      expect(processExitSpy).toHaveBeenCalledWith(3);
    });
  });

  describe('report path conditional', () => {
    it('prints the report path for html format when present', async () => {
      const reportPath = '/tmp/a11y-report.html';
      jest.doMock('../src/a11y/a11y-runner', () => ({
        AccessibilityRunner: jest.fn().mockImplementation(() => ({
          run: jest.fn().mockResolvedValue({
            summary: {
              totalViolations: 1,
              score: 90,
              passed: false,
              violationsBySeverity: { critical: 1, serious: 0, moderate: 0, minor: 0 },
            },
            results: [],
            reportPath,
            duration: 1000,
          }),
        })),
      }));

      jest.resetModules();
      const { runCli } = await import('../src/cli');
      try {
        await runCli(['node', 'iris', 'a11y', '--format', 'html']);
      } catch {
        // exit(4) throws via mock
      }

      const output = consoleLogSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(output).toContain(`Report generated: ${reportPath}`);
    });

    it('does not print a report path for non-html format', async () => {
      jest.doMock('../src/a11y/a11y-runner', () => ({
        AccessibilityRunner: jest.fn().mockImplementation(() => ({
          run: jest.fn().mockResolvedValue({
            summary: {
              totalViolations: 1,
              score: 90,
              passed: false,
              violationsBySeverity: { critical: 1, serious: 0, moderate: 0, minor: 0 },
            },
            results: [],
            reportPath: '/tmp/a11y-report.json',
            duration: 1000,
          }),
        })),
      }));

      jest.resetModules();
      const { runCli } = await import('../src/cli');
      try {
        await runCli(['node', 'iris', 'a11y', '--format', 'json']);
      } catch {
        // exit(4) throws via mock
      }

      const output = consoleLogSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(output).not.toContain('Report generated');
    });
  });
});
