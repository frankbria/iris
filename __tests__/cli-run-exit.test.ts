/**
 * `iris run` exit codes as the OS sees them (#294).
 *
 * cli.test.ts checks which code each path sets; this spawns the real CLI (ts-node,
 * transpile-only, as in hosted-cli.test.ts) to prove the code reaches the parent and
 * that the `--json` payload is complete when it does. None of these cases launches a
 * browser: --dry-run translates only, and a usage error stops before launch.
 */

import { spawn } from 'child_process';
import { once } from 'events';
import { createServer } from 'http';
import { AddressInfo } from 'net';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..');

async function irisRun(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; json: Record<string, unknown> }> {
  const proc = spawn(
    process.execPath,
    ['-r', 'ts-node/register', path.join(REPO_ROOT, 'src/cli.ts'), 'run', ...args, '--json'],
    { cwd: REPO_ROOT, env: { ...process.env, TS_NODE_TRANSPILE_ONLY: '1', ...env } },
  );
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (d) => (stdout += d));
  proc.stderr.on('data', (d) => (stderr += d));
  const [code] = await once(proc, 'exit');
  try {
    return { code, json: JSON.parse(stdout) };
  } catch {
    throw new Error(`no JSON result on stdout.\nstdout: ${stdout}\nstderr: ${stderr}`);
  }
}

describe('iris run exit codes (#294)', () => {
  test('0 when the run succeeds', async () => {
    const { code, json } = await irisRun(['click #btn', '--dry-run']);

    expect(json.status).toBe('success');
    expect(code).toBe(0);
  }, 30_000);

  test('2 on a usage error, with the JSON envelope still on stdout', async () => {
    const { code, json } = await irisRun(['buy a widget', '--agent']);

    expect(json.status).toBe('error');
    expect(code).toBe(2);
  }, 30_000);

  // A real Ollama-shaped provider that is up but fails the request: the reason must
  // reach the caller (#293's `error`), and the run must fail, not exit 0 with no actions.
  test('1 when the AI provider fails, with its reason in translation.error', async () => {
    const provider = createServer((req, res) => {
      if (req.url === '/api/tags') res.end('{"models":[]}');
      else res.writeHead(503).end('overloaded');
    });
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    try {
      const { code, json } = await irisRun(['make sure the cart total is right', '--dry-run'], {
        OLLAMA_ENDPOINT: `http://127.0.0.1:${(provider.address() as AddressInfo).port}`,
      });

      expect(json.status).toBe('error');
      expect((json.translation as { error: string }).error).toMatch(/Ollama request failed: 503/);
      expect(code).toBe(1);
    } finally {
      await new Promise((resolve) => provider.close(resolve));
    }
  }, 30_000);
});
