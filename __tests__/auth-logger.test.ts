/**
 * BetterAuth's logger goes through the IRIS logger (#275, from #341).
 *
 * The api-key plugin logs every refused key at ERROR ("Failed to validate API key"), so
 * a key-spraying client used to fill the hosted server's logs with errors. Expected
 * refusals (unknown, disabled, expired, used-up key) are info now; a backend failure
 * stays at error.
 *
 * Test strategy: BetterAuth is ESM-only, which Jest's sandbox cannot load, so a real
 * Node process (ts-node, transpile-only) builds `createAuth()` and calls
 * `verifyApiKey`, with IRIS_HOSTED=1 so every line is JSON on stderr. The refusal
 * runs over BetterAuth's memory adapter; the backend failure over a Postgres URL whose
 * port refuses at once (`[::1]`: on WSL a closed 127.0.0.1 port hangs, #382), with a
 * marker password that must not be logged. No database is needed.
 */

import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import * as path from 'path';
import { promisify } from 'util';

const REPO_ROOT = path.resolve(__dirname, '..');
const MARK = 'authlog-m4rker-91';

const PROBE = `
const { createAuth } = require('./src/auth/config.ts');
(async () => {
  const { memoryAdapter } = await import('better-auth/adapters/memory');
  // The key table "fails" on demand, as an unreachable or locked database would.
  let down = false;
  const tables = { user: [], session: [], account: [], verification: [], organization: [],
    member: [], invitation: [] };
  Object.defineProperty(tables, 'apikey', { enumerable: true, get() {
    if (down) throw new Error('connect ECONNREFUSED postgres://iris:' + process.env.PROBE_MARK + '@db:5432');
    return [];
  } });
  const auth = createAuth({
    secret: process.env.PROBE_SECRET,
    baseURL: 'https://portal.example.com',
    sendEmail: async () => {},
    database: memoryAdapter(tables),
  });
  const verify = () => auth.api.verifyApiKey({ body: { key: 'iris_' + process.env.PROBE_MARK } });
  process.stderr.write('--- refusal\\n');
  const refused = await verify();
  down = true;
  process.stderr.write('--- backend\\n');
  const failed = await verify();
  process.stdout.write(JSON.stringify({ refused, failed }));
})().catch((e) => { console.error(e); process.exit(1); });
`;

it('logs an expected key refusal at info and a backend failure at error, without secrets', async () => {
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    ['-r', 'ts-node/register', '-e', PROBE],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        TS_NODE_TRANSPILE_ONLY: '1',
        BETTER_AUTH_TELEMETRY: '0',
        IRIS_HOSTED: '1',
        PROBE_SECRET: randomBytes(32).toString('hex'),
        PROBE_MARK: MARK,
      },
    },
  );
  const { refused, failed } = JSON.parse(stdout);
  expect(refused).toMatchObject({ valid: false, error: { code: 'INVALID_API_KEY' } });
  expect(failed.valid).toBe(false);

  const [, refusal, backend] = stderr.split(/^--- \w+\n/m);
  const parse = (block: string) =>
    block
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  const refusalLines = parse(refusal).filter((l) => /API key/.test(l.msg));
  expect(refusalLines).toEqual([
    expect.objectContaining({
      level: 'info',
      msg: 'better-auth: Failed to validate API key:',
      code: 'INVALID_API_KEY',
    }),
  ]);
  const backendLines = parse(backend).filter((l) => /API key/.test(l.msg));
  expect(backendLines).toEqual([
    expect.objectContaining({ level: 'error', msg: 'better-auth: Failed to validate API key:' }),
  ]);
  expect(backendLines[0].err).toMatch(/ECONNREFUSED/);
  // Neither the key nor the database password appears anywhere.
  expect(stderr).not.toContain(MARK);
}, 60_000);
