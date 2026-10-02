import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { apiKeyAuthenticator, hostedServices, KeyStore, KeyVerifier } from '../src/api-key-auth';

/**
 * The refusal rule of `apiKeyAuthenticator` (#341), in-process.
 *
 * Test strategy: the verifier stands in for BetterAuth's `verifyApiKey`, scripted
 * to answer a sequence of results, because what matters here is the decision
 * the authenticator makes from each sequence. The real plugin over real Postgres is
 * exercised in `api-key-auth.test.ts`, which runs in a child process Jest cannot
 * instrument.
 */

type Result = Awaited<ReturnType<KeyVerifier['api']['verifyApiKey']>>;
const VALID: Result = { valid: true, key: { id: 'key-1', referenceId: 'org-1' } };
const INVALID: Result = { valid: false, key: null };

function scripted(...results: Result[]) {
  const keys: string[] = [];
  const verifier: KeyVerifier = {
    api: {
      verifyApiKey: async ({ body }) => {
        keys.push(body.key);
        const next = results.shift();
        if (!next) throw new Error('verifier called more often than scripted');
        return next;
      },
    },
  };
  return { verifier, keys };
}

/** A key store whose rows say every key is `usable` (or that cannot be read). */
function store(usable: boolean | 'down'): KeyStore & { asked: unknown[] } {
  const asked: unknown[] = [];
  const answer = async (arg: unknown) => {
    asked.push(arg);
    if (usable === 'down') throw new Error('connection refused');
    return usable;
  };
  return { asked, isUsable: answer, isLive: answer };
}
/** The key store's own row says the key is gone, disabled, expired or used up. */
const unusable = store(false);
/** The row says the key is fine, so a refusal can only have been a backend failure. */
const usable = store(true);
const down = store('down');

describe('apiKeyAuthenticator', () => {
  test('a valid key resolves to its org and key id', async () => {
    const { verifier, keys } = scripted(VALID);
    expect(await apiKeyAuthenticator(verifier, unusable).verify('Bearer iris_abc')).toEqual({
      orgId: 'org-1',
      keyId: 'key-1',
    });
    expect(keys).toEqual(['iris_abc']);
  });

  test.each([undefined, '', 'Bearer ', 'Basic iris_abc', 'iris_abc'])(
    'header %p is refused without asking the key store',
    async (header) => {
      const { verifier, keys } = scripted();
      expect(await apiKeyAuthenticator(verifier, unusable).verify(header)).toBeNull();
      expect(keys).toEqual([]);
    },
  );

  test('a refusal stands when the key row confirms the key is unusable', async () => {
    const { verifier } = scripted(INVALID);
    const rows = store(false);
    expect(await apiKeyAuthenticator(verifier, rows).verify('Bearer iris_gone')).toBeNull();
    expect(rows.asked).toEqual(['iris_gone']);
  });

  test('a refusal of a usable key is a backend failure, never a verdict', async () => {
    // The plugin reports a locked table, a read-only database or a timed-out
    // lookup as `valid: false`, exactly like an unknown key.
    const { verifier } = scripted(INVALID);
    await expect(apiKeyAuthenticator(verifier, usable).verify('Bearer iris_abc')).rejects.toThrow(
      /usable key/,
    );
  });

  test('an unreachable key store is an error, never a refusal', async () => {
    const { verifier } = scripted(INVALID);
    await expect(apiKeyAuthenticator(verifier, down).verify('Bearer iris_abc')).rejects.toThrow(
      'connection refused',
    );
  });
});

describe('apiKeyAuthenticator.recheck', () => {
  test('asks the key store by principal and never calls verifyApiKey', async () => {
    const { verifier, keys } = scripted();
    const rows = store(true);
    const principal = { orgId: 'org-1', keyId: 'key-1' };
    expect(await apiKeyAuthenticator(verifier, rows).recheck(principal)).toBe(true);
    expect(await apiKeyAuthenticator(verifier, store(false)).recheck(principal)).toBe(false);
    expect(rows.asked).toEqual([principal]);
    // verifyApiKey writes lastRequest (and spends `remaining`); a re-check must not.
    expect(keys).toEqual([]);
  });

  test('rejects on a store failure, so the server keeps the connection', async () => {
    const { verifier } = scripted();
    await expect(
      apiKeyAuthenticator(verifier, down).recheck({ orgId: 'o', keyId: 'k' }),
    ).rejects.toThrow('connection refused');
  });
});

describe('hostedServices', () => {
  test('names every missing auth setting before touching the database', async () => {
    await expect(hostedServices({})).rejects.toThrow(
      'Hosted mode needs BETTER_AUTH_SECRET and BETTER_AUTH_URL',
    );
    await expect(hostedServices({ BETTER_AUTH_SECRET: 's' })).rejects.toThrow(
      'Hosted mode needs BETTER_AUTH_URL',
    );
  });

  test('reads the secret from BETTER_AUTH_SECRET_FILE (#273)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-auth-secret-'));
    const file = path.join(dir, 'secret');
    fs.writeFileSync(file, 's\n');
    try {
      // Past the secret check: the next thing missing is the URL.
      await expect(hostedServices({ BETTER_AUTH_SECRET_FILE: file })).rejects.toThrow(
        'Hosted mode needs BETTER_AUTH_URL',
      );
      await expect(
        hostedServices({ BETTER_AUTH_SECRET: 's', BETTER_AUTH_SECRET_FILE: file }),
      ).rejects.toThrow(/one at a time/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
