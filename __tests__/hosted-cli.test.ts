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
import * as fs from 'fs';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import * as os from 'os';
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

describe('iris watch URL policy', () => {
  // The watcher renders the changed file over file://. CDP's Fetch domain never
  // pauses a file:// URL, so only a check before page.goto can refuse it.
  it('--execute refuses to render the changed file under IRIS_HOSTED=1', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-hosted-watch-'));
    const file = path.join(dir, 'page.html');
    fs.writeFileSync(file, '<button id="b">b</button>');
    const proc = spawn(
      process.execPath,
      [
        '-r',
        'ts-node/register',
        path.join(REPO_ROOT, 'src/cli.ts'),
        'watch',
        file,
        '--execute',
        '-i',
        'click #b',
      ],
      { cwd: REPO_ROOT, env: { ...process.env, TS_NODE_TRANSPILE_ONLY: '1', IRIS_HOSTED: '1' } },
    );
    let output = '';
    proc.stdout.on('data', (d) => (output += d));
    proc.stderr.on('data', (d) => (output += d));
    try {
      // Iteration counts, not Date.now() deadlines: the WSL2 clock can step (#190).
      const waitFor = async (re: RegExp, what: string, onTick?: (i: number) => void) => {
        for (let i = 0; !re.test(output); i++) {
          if (i >= 200) throw new Error(`timed out waiting for ${what}.\n${output}`);
          onTick?.(i);
          await new Promise((r) => setTimeout(r, 100));
        }
      };
      await waitFor(/Waiting for changes/, 'the watcher to be ready');
      // Touch the file every 3s, longer than the 1s debounce, which a faster
      // loop would keep resetting.
      await waitFor(/Navigation blocked: file/, 'the refusal', (i) => {
        if (i % 30 === 0) fs.writeFileSync(file, `<button id="b">b${i}</button>`);
      });
      expect(output).not.toMatch(/Executing: click/);
    } finally {
      proc.kill();
      await once(proc, 'exit');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
