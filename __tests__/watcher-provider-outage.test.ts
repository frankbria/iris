/**
 * `iris watch` and an AI provider that is up but fails (#511). The translator reports it
 * as `TranslationResult.error` (#293, #294); the watcher used to ignore that and log
 * "No actions generated from instruction", which reads as a plan the model could not
 * make. Real Ollama-shaped HTTP server, real translator, no mocks of either.
 */
import { createServer, Server } from 'http';
import type { AddressInfo } from 'net';
import { once } from 'events';
import { FileWatcher } from '../src/watcher';
import { getTestRuns, initializeDatabase } from '../src/db';
import { resolveDbPath } from '../src/data-dir';

describe('iris watch when the AI provider fails (#511)', () => {
  let provider: Server;
  const saved = process.env.OLLAMA_ENDPOINT;

  beforeAll(async () => {
    provider = createServer((req, res) => {
      if (req.url === '/api/tags') res.end('{"models":[]}');
      else res.writeHead(503).end('overloaded');
    });
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    process.env.OLLAMA_ENDPOINT = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (saved === undefined) delete process.env.OLLAMA_ENDPOINT;
    else process.env.OLLAMA_ENDPOINT = saved;
    await new Promise((resolve) => provider.close(resolve));
  });

  it('logs the provider failure with its reason and records the run as an error', async () => {
    const logged: string[] = [];
    const errors: string[] = [];
    const watcher = new FileWatcher({
      cwd: process.cwd(),
      // Prose, so no pattern matches and the AI is asked.
      instruction: 'make sure the cart total is right',
      logger: {
        log: (...a: unknown[]) => logged.push(a.join(' ')),
        warn: (...a: unknown[]) => logged.push(a.join(' ')),
        error: (...a: unknown[]) => errors.push(a.join(' ')),
      },
    });

    await (
      watcher as unknown as { executeInstruction(e: object): Promise<void> }
    ).executeInstruction({ type: 'change', path: 'index.html' });

    expect(errors.join('\n')).toMatch(/AI translation failed: .*Ollama request failed: 503/);
    expect(logged.join('\n')).not.toMatch(/No actions generated/);
    const db = initializeDatabase(resolveDbPath());
    try {
      const [latest] = getTestRuns(db, 1);
      expect(latest).toMatchObject({ status: 'error' });
      expect(latest.instruction).toContain('make sure the cart total is right');
    } finally {
      db.close();
    }
  }, 30_000);
});
