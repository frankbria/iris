/**
 * Hosted mode does not read `.env` (issue #358).
 *
 * `runCli()` loads `.env` from the working directory into unset variables. In hosted mode
 * the configuration is the deploy's environment and `_FILE` secrets only: a stray `.env`
 * in the image or working directory must not supply a credential. The CLI runs as a real
 * child, because IRIS_HOSTED is read once per process.
 *
 * Observable: hosted `iris connect` refuses a shared token (exit 2). With the token only in
 * `.env`, a CLI that read it exits 2; one that did not proceeds to its next check, the
 * missing database and auth settings (exit 3).
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..');

function connect(env: NodeJS.ProcessEnv): Promise<{ code: number | null; stderr: string }> {
  const proc = spawn(
    process.execPath,
    ['-r', 'ts-node/register', path.join(REPO_ROOT, 'src/cli.ts'), 'connect', '45358'],
    { cwd: REPO_ROOT, env: { PATH: process.env.PATH, TS_NODE_TRANSPILE_ONLY: '1', ...env } },
  );
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d));
  return new Promise((resolve) => proc.on('exit', (code) => resolve({ code, stderr })));
}

describe('hosted mode ignores .env (#358)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-358-'));
    fs.writeFileSync(path.join(dir, '.env'), 'IRIS_CONNECT_TOKEN=from-dotenv\n');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('does not take a credential from .env', async () => {
    const { code, stderr } = await connect({ IRIS_HOSTED: '1', IRIS_DOTENV_DIR: dir });
    expect(stderr).not.toMatch(/unset IRIS_CONNECT_TOKEN/);
    expect(stderr).toMatch(/Cannot start in hosted mode/);
    expect(code).toBe(3);
  }, 60_000);

  // Positive control: the same token from the real environment is refused, so exit 3
  // above means .env was skipped, not that hosted mode ignores tokens altogether.
  it('still refuses the same token from the environment', async () => {
    const { code, stderr } = await connect({
      IRIS_HOSTED: '1',
      IRIS_DOTENV_DIR: dir,
      IRIS_CONNECT_TOKEN: 'from-env',
    });
    expect(stderr).toMatch(/unset IRIS_CONNECT_TOKEN/);
    expect(code).toBe(2);
  }, 60_000);
});
