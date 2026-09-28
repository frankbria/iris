/**
 * Shared BetterAuth config loads from the CommonJS build (issue #247, ADR 0001 §4).
 *
 * Test strategy: `better-auth` is ESM-only, and the question is whether Node's
 * `require(esm)` loads it from IRIS's CommonJS output. Jest's sandboxed
 * `require` does not implement `require(esm)` at all, so an in-process import
 * would test Jest, not Node. The config is loaded in a real child process
 * through ts-node (transpile-only), which emits the same `require()` calls as
 * `tsc` without racing the MCP suite's build of `dist/`.
 */

import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import * as path from 'path';
import { promisify } from 'util';

const REPO_ROOT = path.resolve(__dirname, '..');

const PROBE = `
const { createAuth } = require('./src/auth/config.ts');
const auth = createAuth({ secret: process.env.PROBE_SECRET, baseURL: 'http://localhost:3000' });
process.stdout.write(JSON.stringify({
  handler: typeof auth.handler,
  createOrganization: typeof auth.api.createOrganization,
}));
`;

describe('shared auth config (require(esm))', () => {
  it('loads better-auth and its organization plugin from CommonJS', async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['-r', 'ts-node/register', '-e', PROBE],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          TS_NODE_TRANSPILE_ONLY: '1',
          BETTER_AUTH_TELEMETRY: '0',
          PROBE_SECRET: randomBytes(32).toString('hex'),
        },
      },
    );

    expect(JSON.parse(stdout)).toEqual({ handler: 'function', createOrganization: 'function' });
  }, 30_000);
});
