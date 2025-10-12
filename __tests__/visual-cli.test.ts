/**
 * Integration tests for visual-diff CLI command
 */

import { runCli } from '../src/cli';

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
                minor: 0
              }
            },
            results: [],
            reportPath: undefined,
            duration: 1000
          })
        }))
      }));

      jest.resetModules();
      const { runCli: freshRunCli } = await import('../src/cli');

      // Run command without help flag - should execute successfully
      await freshRunCli(['node', 'iris', 'visual-diff', '--pages', '/']);

      // Verify command executed (output captured)
      const output = consoleLogSpy.mock.calls.map(call => call.join(' ')).join('\n');
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
          severityCounts: {}
        },
        results: [],
        duration: 1000
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
        })
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
          severityCounts: {}
        },
        results: [],
        duration: 1000
      });

      // Mock implementation
      jest.doMock('../src/visual/visual-runner', () => ({
        VisualTestRunner: jest.fn().mockImplementation((config) => {
          // Verify pages are parsed correctly
          expect(config.pages).toEqual(['/', '/about', '/contact']);
          return { run: mockRun };
        })
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
          severityCounts: {}
        },
        results: [],
        duration: 1000
      });

      jest.doMock('../src/visual/visual-runner', () => ({
        VisualTestRunner: jest.fn().mockImplementation((config) => {
          expect(config.baseline.reference).toBe('develop');
          return { run: mockRun };
        })
      }));

      jest.resetModules();
      const { runCli: freshRunCli } = await import('../src/cli');

      await freshRunCli(['node', 'iris', 'visual-diff', '--baseline', 'develop']);

      expect(mockRun).toHaveBeenCalled();
    });

    it('should enable semantic analysis when flag is set', async () => {
      const mockRun = jest.fn().mockResolvedValue({
        summary: {
          totalComparisons: 1,
          passed: 1,
          failed: 0,
          newBaselines: 0,
          overallStatus: 'passed',
          severityCounts: {}
        },
        results: [],
        duration: 1000
      });

      jest.doMock('../src/visual/visual-runner', () => ({
        VisualTestRunner: jest.fn().mockImplementation((config) => {
          expect(config.diff.semanticAnalysis).toBe(true);
          return { run: mockRun };
        })
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
          severityCounts: {}
        },
        results: [],
        duration: 1000
      });

      jest.doMock('../src/visual/visual-runner', () => ({
        VisualTestRunner: jest.fn().mockImplementation((config) => {
          expect(config.diff.threshold).toBe(0.15);
          return { run: mockRun };
        })
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
              severityCounts: {}
            },
            results: [],
            duration: 1000
          })
        }))
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
                minor: 0
              }
            },
            results: [],
            duration: 1000
          })
        }))
      }));

      jest.resetModules();
      const { runCli: freshRunCli } = await import('../src/cli');

      try {
        await freshRunCli(['node', 'iris', 'visual-diff', '--fail-on', 'breaking']);
      } catch (error) {
        // Expected to throw due to process.exit mock
      }

      expect(processExitSpy).toHaveBeenCalledWith(5);
    });

    it('should exit with 3 when command execution fails', async () => {
      jest.doMock('../src/visual/visual-runner', () => ({
        VisualTestRunner: jest.fn().mockImplementation(() => ({
          run: jest.fn().mockRejectedValue(new Error('Browser launch failed'))
        }))
      }));

      jest.resetModules();
      const { runCli: freshRunCli } = await import('../src/cli');

      try {
        await freshRunCli(['node', 'iris', 'visual-diff']);
      } catch (error) {
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
                minor: 0
              }
            },
            results: [],
            reportPath: '/path/to/report.html',
            duration: 2500
          })
        }))
      }));

      jest.resetModules();
      const { runCli: freshRunCli } = await import('../src/cli');

      try {
        await freshRunCli(['node', 'iris', 'visual-diff', '--format', 'html']);
      } catch (error) {
        // May throw due to exit
      }

      const output = consoleLogSpy.mock.calls.map(call => call.join(' ')).join('\n');
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
              severityCounts: { breaking: 1 }
            },
            results: [],
            reportPath,
            duration: 1000
          })
        }))
      }));

      jest.resetModules();
      const { runCli: freshRunCli } = await import('../src/cli');

      try {
        await freshRunCli(['node', 'iris', 'visual-diff', '--format', 'html']);
      } catch (error) {
        // May throw
      }

      const output = consoleLogSpy.mock.calls.map(call => call.join(' ')).join('\n');
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
          severityCounts: {}
        },
        results: [],
        duration: 1000
      });

      jest.doMock('../src/visual/visual-runner', () => ({
        VisualTestRunner: jest.fn().mockImplementation((config) => {
          expect(config.capture.mask).toEqual(['.ad', '.popup', '.timestamp']);
          return { run: mockRun };
        })
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
          severityCounts: {}
        },
        results: [],
        duration: 3000
      });

      jest.doMock('../src/visual/visual-runner', () => ({
        VisualTestRunner: jest.fn().mockImplementation((config) => {
          expect(config.devices).toEqual(['desktop', 'mobile', 'tablet']);
          return { run: mockRun };
        })
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
          severityCounts: {}
        },
        results: [],
        duration: 1000
      });

      jest.doMock('../src/visual/visual-runner', () => ({
        VisualTestRunner: jest.fn().mockImplementation((config) => {
          expect(config.updateBaseline).toBe(true);
          return { run: mockRun };
        })
      }));

      jest.resetModules();
      const { runCli: freshRunCli } = await import('../src/cli');

      await freshRunCli(['node', 'iris', 'visual-diff', '--update-baseline']);

      expect(mockRun).toHaveBeenCalled();
    });
  });
});
