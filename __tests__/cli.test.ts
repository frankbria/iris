import { runCli } from '../src/cli';

describe('CLI Commands', () => {
  let consoleOutput: string[];
  const mockedLog = (output: string) => consoleOutput.push(output);

  beforeEach(() => {
    consoleOutput = [];
    jest.spyOn(console, 'log').mockImplementation(mockedLog);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('run command prints instruction', () => {
    runCli(['node', 'iris', 'run', 'do something']);
    expect(consoleOutput).toContain('Running instruction: do something');
  });

  test('watch command prints target or default', () => {
    runCli(['node', 'iris', 'watch', 'app.ts']);
    expect(consoleOutput).toContain('Watching: app.ts');
    runCli(['node', 'iris', 'watch']);
    expect(consoleOutput).toContain('Watching: default');
  });

  test('connect command prints server start message', () => {
    runCli(['node', 'iris', 'connect']);
    expect(consoleOutput).toContain('Starting JSON-RPC/WebSocket server...');
  });
});
