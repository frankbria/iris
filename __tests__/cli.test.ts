import { runCli } from '../src/cli';
import { initializeDatabase, getTestRuns } from '../src/db';
import * as fs from 'fs';
import * as path from 'path';

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
    // Mock the startServer function to avoid actually starting a server
    const mockStartServer = jest.fn();
    jest.doMock('../src/protocol', () => ({
      startServer: mockStartServer
    }));

    await runCli(['node', 'iris', 'connect']);
    expect(consoleOutput).toContain(
      'JSON-RPC server listening on ws://localhost:4000'
    );
    expect(mockStartServer).toHaveBeenCalledWith(4000);
  });

  test('run command persists test execution to database', async () => {
    const testDbPath = path.join(__dirname, 'test-cli.db');

    // Clean up test database
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }

    // Set environment variable for test database path
    process.env.IRIS_DB_PATH = testDbPath;

    try {
      await runCli(['node', 'iris', 'run', 'click #submit']);

      // Verify record was persisted
      const db = initializeDatabase(testDbPath);
      const runs = getTestRuns(db);

      expect(runs).toHaveLength(1);
      expect(runs[0].instruction).toBe('click #submit');
      expect(runs[0].status).toBe('success');
      expect(runs[0].startTime).toBeInstanceOf(Date);
      expect(runs[0].endTime).toBeInstanceOf(Date);

      db.close();
    } finally {
      // Clean up
      delete process.env.IRIS_DB_PATH;
      if (fs.existsSync(testDbPath)) {
        fs.unlinkSync(testDbPath);
      }
    }
  });
});
