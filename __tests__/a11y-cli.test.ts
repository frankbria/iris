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
      scannedPassed: true,
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

    // #289: the runner config a11y builds from the given flags.
    async function configFor(args: string[]): Promise<any> {
      let captured: any;
      jest.doMock('../src/a11y/a11y-runner', () => ({
        AccessibilityRunner: jest.fn().mockImplementation((config) => {
          captured = config;
          return { run: jest.fn().mockResolvedValue(passingResult) };
        }),
      }));
      jest.resetModules();
      const { runCli } = await import('../src/cli');
      try {
        await runCli(['node', 'iris', 'a11y', ...args]);
      } catch {
        // process.exit is mocked to throw
      }
      return captured;
    }

    it('takes repeated --pages, and keeps a data: URL with commas whole', async () => {
      const data = 'data:text/html,<p>a,b</p>';
      const config = await configFor([
        '--pages',
        '/',
        '--pages',
        data,
        '--pages',
        '/about,/contact',
      ]);
      expect(config.pages).toEqual(['/', data, '/about', '/contact']);
    });

    it('defaults --pages to / only when none is given', async () => {
      expect((await configFor([])).pages).toEqual(['/']);
      expect((await configFor(['--pages', '/x'])).pages).toEqual(['/x']);
    });

    // An empty value (an unset "$PAGES" in CI) must not become zero pages, which pass.
    it.each([[''], [','], [' ']])(
      'refuses --pages %p instead of scanning nothing',
      async (value) => {
        const config = await configFor(['--pages', value]);
        expect(config).toBeUndefined(); // no scan ran
        expect(processExitSpy).toHaveBeenCalledWith(1);
      },
    );

    // The old comma form with full URLs: https://a.com/,https://b.com/ parses as ONE valid URL
    // (path "/,https://b.com/"), whose page could load and pass. Refused, not guessed at.
    it.each([['https://a.com/,https://b.com/'], ['http://a.com/x, https://b.com']])(
      'refuses several URLs in one --pages value (%p)',
      async (value) => {
        // commander reports option errors on stderr directly, not through console.error
        const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const config = await configFor(['--pages', value]);
        expect(config).toBeUndefined();
        expect(processExitSpy).toHaveBeenCalledWith(1);
        expect(stderr.mock.calls.flat().join(' ')).toMatch(/repeat --pages/);
        stderr.mockRestore();
      },
    );

    it('keeps a data: page whose markup holds ",https://" as one page', async () => {
      const data = 'data:text/html,<a href="x,https://b.com">l</a>';
      expect((await configFor(['--pages', data])).pages).toEqual([data]);
    });

    it('accepts --fail-on in any case', async () => {
      const config = await configFor(['--fail-on', 'Critical, SERIOUS']);
      expect(config.failureThreshold).toEqual({ critical: true, serious: true });
    });

    it.each([['critcal'], ['critical,bogus'], [' , ']])(
      'refuses --fail-on %p instead of silently passing (exit 2)',
      async (value) => {
        const config = await configFor(['--fail-on', value]);
        expect(config).toBeUndefined(); // no scan ran
        expect(processExitSpy).toHaveBeenCalledWith(2);
        expect(consoleErrorSpy.mock.calls.flat().join(' ')).toMatch(/--fail-on/);
      },
    );

    it('turns keyboard testing off with --no-include-keyboard', async () => {
      const off = await configFor(['--no-include-keyboard']);
      expect(off.keyboard).toMatchObject({ testFocusOrder: false, testArrowKeyNavigation: false });
      const on = await configFor([]);
      expect(on.keyboard).toMatchObject({ testFocusOrder: true, testArrowKeyNavigation: true });
    });

    // Issue #72: --rules was declared on the command but never read, so a scoped
    // scan silently ran as a full default-tag scan.
    it('parses --rules into runOnlyRules', async () => {
      const mockRun = jest.fn().mockResolvedValue(passingResult);

      jest.doMock('../src/a11y/a11y-runner', () => ({
        AccessibilityRunner: jest.fn().mockImplementation((config) => {
          expect(config.axe.runOnlyRules).toEqual(['color-contrast', 'link-name']);
          return { run: mockRun };
        }),
      }));

      jest.resetModules();
      const { runCli } = await import('../src/cli');
      await runCli(['node', 'iris', 'a11y', '--rules', 'color-contrast, link-name']);

      expect(mockRun).toHaveBeenCalled();
    });

    // Issue #77: AxeRunner has always honoured `axe.exclude` (axe-integration.ts),
    // but the CLI hardcoded `[]`, so the capability had no way in. The matching
    // `--exclude` flag meanwhile sat on `iris visual`, where nothing read it.
    it('parses --exclude into the axe exclude list', async () => {
      const mockRun = jest.fn().mockResolvedValue(passingResult);

      jest.doMock('../src/a11y/a11y-runner', () => ({
        AccessibilityRunner: jest.fn().mockImplementation((config) => {
          expect(config.axe.exclude).toEqual(['.ads', '#tracking-pixel']);
          return { run: mockRun };
        }),
      }));

      jest.resetModules();
      const { runCli } = await import('../src/cli');
      await runCli(['node', 'iris', 'a11y', '--exclude', '.ads, #tracking-pixel']);

      expect(mockRun).toHaveBeenCalled();
    });

    it('defaults the axe exclude list to empty when --exclude is omitted', async () => {
      const mockRun = jest.fn().mockResolvedValue(passingResult);

      jest.doMock('../src/a11y/a11y-runner', () => ({
        AccessibilityRunner: jest.fn().mockImplementation((config) => {
          expect(config.axe.exclude).toEqual([]);
          return { run: mockRun };
        }),
      }));

      jest.resetModules();
      const { runCli } = await import('../src/cli');
      await runCli(['node', 'iris', 'a11y']);

      expect(mockRun).toHaveBeenCalled();
    });

    it('leaves runOnlyRules undefined when --rules is omitted', async () => {
      const mockRun = jest.fn().mockResolvedValue(passingResult);

      jest.doMock('../src/a11y/a11y-runner', () => ({
        AccessibilityRunner: jest.fn().mockImplementation((config) => {
          // undefined, not [] — an empty array would be a runOnly matching nothing.
          expect(config.axe.runOnlyRules).toBeUndefined();
          return { run: mockRun };
        }),
      }));

      jest.resetModules();
      const { runCli } = await import('../src/cli');
      await runCli(['node', 'iris', 'a11y']);

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

  // Issue #77 — same gap as the visual command: results were never persisted.
  describe('run history', () => {
    it('records the run, including on the violation path that exits non-zero', async () => {
      const recordA11yRun = jest.fn();
      jest.doMock('../src/history', () => ({ recordA11yRun }));
      jest.doMock('../src/a11y/a11y-runner', () => ({
        AccessibilityRunner: jest.fn().mockImplementation(() => ({
          run: jest.fn().mockResolvedValue({
            ...passingResult,
            summary: {
              ...passingResult.summary,
              totalViolations: 2,
              passed: false,
              scannedPassed: false,
            },
          }),
        })),
      }));

      jest.resetModules();
      const { runCli } = await import('../src/cli');

      try {
        await runCli(['node', 'iris', 'a11y']);
      } catch {
        // process.exit is mocked to throw
      }

      expect(recordA11yRun).toHaveBeenCalledTimes(1);
      expect(recordA11yRun.mock.calls[0][0].summary.totalViolations).toBe(2);
    });
  });

  describe('exit codes', () => {
    // #287: a page the runner could not scan is reported, not counted as clean; the run
    // exits 3 as it did when that page's error ended the run.
    it('exits 4, not 3, when scanned pages have violations and another page errored', async () => {
      jest.doMock('../src/a11y/a11y-runner', () => ({
        AccessibilityRunner: jest.fn().mockImplementation(() => ({
          run: jest.fn().mockResolvedValue({
            ...passingResult,
            summary: {
              ...passingResult.summary,
              totalViolations: 1,
              passed: false,
              scannedPassed: false,
              pagesErrored: 1,
              violationsBySeverity: { critical: 1, serious: 0, moderate: 0, minor: 0 },
            },
            results: [
              { page: '/bad', axeResult: { violations: [{}] } },
              {
                page: '/down',
                error: 'net::ERR_CONNECTION_REFUSED',
                axeResult: { violations: [] },
              },
            ],
          }),
        })),
      }));

      jest.resetModules();
      const { runCli } = await import('../src/cli');
      await expect(runCli(['node', 'iris', 'a11y', '--pages', '/bad,/down'])).rejects.toThrow(
        'process.exit called',
      );

      // A violation is a finding a pipeline must not retry away as a flake (exit 3).
      expect(processExitSpy).toHaveBeenCalledWith(4);
      const out = consoleLogSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(out).toMatch(/Critical: 1/);
      expect(out).toMatch(/\/down: net::ERR_CONNECTION_REFUSED/);
    });

    it('lists pages that could not be scanned and exits 3', async () => {
      jest.doMock('../src/a11y/a11y-runner', () => ({
        AccessibilityRunner: jest.fn().mockImplementation(() => ({
          run: jest.fn().mockResolvedValue({
            ...passingResult,
            summary: { ...passingResult.summary, passed: false, pagesErrored: 1 },
            results: [
              { page: '/ok', axeResult: { violations: [] } },
              {
                page: '/down',
                error: 'net::ERR_CONNECTION_REFUSED',
                axeResult: { violations: [] },
              },
            ],
          }),
        })),
      }));

      jest.resetModules();
      const { runCli } = await import('../src/cli');
      await expect(runCli(['node', 'iris', 'a11y', '--pages', '/ok,/down'])).rejects.toThrow(
        'process.exit called',
      );

      expect(processExitSpy).toHaveBeenCalledWith(3);
      const out = consoleLogSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(out).toMatch(/1 page\(s\) could not be scanned/);
      expect(out).toMatch(/\/down: net::ERR_CONNECTION_REFUSED/);
    });

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
              scannedPassed: false,
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
              scannedPassed: false,
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
              scannedPassed: false,
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
