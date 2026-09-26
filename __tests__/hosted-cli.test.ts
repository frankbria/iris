/**
 * `iris run` under the hosted URL policy (#334).
 *
 * Test strategy: IRIS_HOSTED is read once per process, so the CLI runs as a real
 * child (ts-node, transpile-only, as in protocol-robustness.test.ts) with the
 * variable set the way each case needs. The pattern translator turns
 * "navigate to <url>" into one navigate action without any AI provider, and
 * `--json` reports each action's result, including the policy's refusal.
 */

import { spawn } from 'child_process';
import { once } from 'events';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..');

interface RunResult {
  results: Array<{ success: boolean; error?: string }>;
}

async function irisRun(
  url: string,
  env: NodeJS.ProcessEnv,
  flags: string[] = [],
): Promise<RunResult> {
  const proc = spawn(
    process.execPath,
    [
      '-r',
      'ts-node/register',
      path.join(REPO_ROOT, 'src/cli.ts'),
      'run',
      `navigate to ${url}`,
      '--json',
      ...flags,
    ],
    { cwd: REPO_ROOT, env: { ...process.env, TS_NODE_TRANSPILE_ONLY: '1', ...env } },
  );
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (d) => (stdout += d));
  proc.stderr.on('data', (d) => (stderr += d));
  await once(proc, 'exit');
  try {
    return JSON.parse(stdout) as RunResult;
  } catch {
    throw new Error(`no JSON result on stdout.\nstdout: ${stdout}\nstderr: ${stderr}`);
  }
}

// 100.64.0.0 rather than an arbitrary CGNAT host: see the #329 hygiene allowlist.
const INTERNAL_TARGETS = [
  'http://127.0.0.1/',
  'http://10.0.0.1/',
  'http://100.64.0.0/',
  'http://169.254.169.254/',
];

describe('iris run URL policy', () => {
  let page: Server;
  let pageUrl: string;

  beforeAll(async () => {
    page = createServer((_req, res) => res.end('<html><body>ok</body></html>'));
    page.listen(0, '127.0.0.1');
    await once(page, 'listening');
    pageUrl = `http://127.0.0.1:${(page.address() as AddressInfo).port}/`;
  });

  afterAll(() => new Promise((resolve) => page.close(resolve)));

  it.each(INTERNAL_TARGETS)(
    'refuses %s under IRIS_HOSTED=1',
    async (url) => {
      const { results } = await irisRun(url, { IRIS_HOSTED: '1' });
      expect(results[0]).toMatchObject({
        success: false,
        error: expect.stringMatching(/Navigation blocked/),
      });
    },
    60_000,
  );

  it('local mode still reaches a loopback page', async () => {
    const { results } = await irisRun(pageUrl, {});
    expect(results[0]).toMatchObject({ success: true });
  }, 60_000);

  it('--block-private-hosts refuses that same page in local mode', async () => {
    const { results } = await irisRun(pageUrl, {}, ['--block-private-hosts']);
    expect(results[0]).toMatchObject({
      success: false,
      error: expect.stringMatching(/private\/loopback/),
    });
  }, 60_000);
});
