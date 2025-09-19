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

  test('run command prints translated actions as JSON', async () => {
    await runCli(['node', 'iris', 'run', 'click #btn']);
    expect(consoleOutput).toContain(JSON.stringify([{ type: 'click', selector: '#btn' }]));
  });

  test('watch command prints target or default', async () => {
    await runCli(['node', 'iris', 'watch', 'app.ts']);
    expect(consoleOutput).toContain('Watching: app.ts');
    consoleOutput = [];
    await runCli(['node', 'iris', 'watch']);
    expect(consoleOutput).toContain('Watching: default');
  });

  test('connect command prints server start message', async () => {
    await runCli(['node', 'iris', 'connect']);
    expect(consoleOutput).toContain('Starting JSON-RPC/WebSocket server...');
  });
});
