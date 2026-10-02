import { apiKeyAuthenticator, hostedAuthenticator, KeyVerifier } from '../src/api-key-auth';

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

const up = async () => undefined;
const down = async () => {
  throw new Error('connection refused');
};

describe('apiKeyAuthenticator', () => {
  test('a valid key resolves to its org and key id', async () => {
    const { verifier, keys } = scripted(VALID);
    expect(await apiKeyAuthenticator(verifier, up)('Bearer iris_abc')).toEqual({
      orgId: 'org-1',
      keyId: 'key-1',
    });
    expect(keys).toEqual(['iris_abc']);
  });

  test.each([undefined, '', 'Bearer ', 'Basic iris_abc', 'iris_abc'])(
    'header %p is refused without asking the key store',
    async (header) => {
      const { verifier, keys } = scripted();
      expect(await apiKeyAuthenticator(verifier, up)(header)).toBeNull();
      expect(keys).toEqual([]);
    },
  );

  test('a refusal stands only when it repeats while the key store answers', async () => {
    const { verifier, keys } = scripted(INVALID, INVALID);
    expect(await apiKeyAuthenticator(verifier, up)('Bearer iris_gone')).toBeNull();
    expect(keys).toEqual(['iris_gone', 'iris_gone']);
  });

  test('a refusal caused by a database blip is retried, not believed', async () => {
    // The plugin reports a timed-out lookup as `valid: false`. By the time the
    // reachability probe runs the database is back, so the key is asked again.
    const { verifier } = scripted(INVALID, VALID);
    expect(await apiKeyAuthenticator(verifier, up)('Bearer iris_abc')).toEqual({
      orgId: 'org-1',
      keyId: 'key-1',
    });
  });

  test('an unreachable key store is an error, never a refusal', async () => {
    const { verifier } = scripted(INVALID);
    await expect(apiKeyAuthenticator(verifier, down)('Bearer iris_abc')).rejects.toThrow(
      'connection refused',
    );
  });
});

describe('hostedAuthenticator', () => {
  test('names every missing auth setting before touching the database', async () => {
    await expect(hostedAuthenticator({})).rejects.toThrow(
      'Hosted mode needs BETTER_AUTH_SECRET and BETTER_AUTH_URL',
    );
    await expect(hostedAuthenticator({ BETTER_AUTH_SECRET: 's' })).rejects.toThrow(
      'Hosted mode needs BETTER_AUTH_URL',
    );
  });
});
