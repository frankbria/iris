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
(async () => {
  const auth = createAuth({
    secret: process.env.PROBE_SECRET,
    baseURL: process.env.PROBE_BASE_URL,
    sendEmail: async () => {},
    // A caller trying to relax the policy: createAuth must not let it through.
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    emailVerification: { autoSignInAfterVerification: true, expiresIn: 600 },
    rateLimit: { enabled: false, storage: 'database' },
    // #347: the client-IP header is pinned; the caller's other advanced keys are not.
    advanced: {
      cookiePrefix: 'probe',
      ipAddress: { ipAddressHeaders: ['x-forwarded-for'], trustedProxies: ['10.0.0.0/8'] },
    },
  });
  const ctx = await auth.$context;
  process.stdout.write(JSON.stringify({
    handler: typeof auth.handler,
    createOrganization: typeof auth.api.createOrganization,
    apiKey: [auth.api.createApiKey, auth.api.listApiKeys, auth.api.deleteApiKey, auth.api.verifyApiKey]
      .map((fn) => typeof fn),
    cookie: ctx.authCookies.sessionToken.attributes,
    rateLimit: ctx.rateLimit.enabled,
    rateLimitStorage: ctx.options.rateLimit.storage,
    verificationExpiresIn: ctx.options.emailVerification.expiresIn,
    requireEmailVerification: ctx.options.emailAndPassword.requireEmailVerification,
    sendOnSignUp: ctx.options.emailVerification.sendOnSignUp,
    sendOnSignIn: ctx.options.emailVerification.sendOnSignIn,
    autoSignInAfterVerification: ctx.options.emailVerification.autoSignInAfterVerification,
    revokeSessionsOnPasswordReset: ctx.options.emailAndPassword.revokeSessionsOnPasswordReset,
    advanced: ctx.options.advanced,
  }));
})().catch((e) => { console.error(e); process.exit(1); });
`;

async function probe(baseURL: string) {
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
        PROBE_BASE_URL: baseURL,
      },
    },
  );
  return JSON.parse(stdout);
}

describe('shared auth config (require(esm))', () => {
  it('loads better-auth and its organization plugin from CommonJS', async () => {
    const out = await probe('http://localhost:3000');
    expect(out).toMatchObject({ handler: 'function', createOrganization: 'function' });
  }, 30_000);

  // #340: the api-key plugin is its own ESM-only package (@better-auth/api-key in 1.7),
  // so it is a second require(esm) load, not part of better-auth/plugins.
  it('loads the api-key plugin: create, list, delete and verify endpoints', async () => {
    const out = await probe('http://localhost:3000');
    expect(out.apiKey).toEqual(['function', 'function', 'function', 'function']);
  }, 30_000);

  // #249: the account policy lives in the shared config, so the portal and the
  // API cannot disagree about it, and a caller's options cannot relax it.
  it('requires email verification, rate-limits in every environment, revokes sessions on reset', async () => {
    const out = await probe('http://localhost:3000');
    expect(out).toMatchObject({
      rateLimit: true,
      requireEmailVerification: true,
      sendOnSignUp: true,
      // A lost link is recoverable: signing in again mails a fresh one.
      sendOnSignIn: true,
      // A mailed link must not sign a browser in (login CSRF).
      autoSignInAfterVerification: false,
      revokeSessionsOnPasswordReset: true,
    });
  }, 30_000);

  // The policy pins its keys and nothing else: a caller's other keys (a shorter link
  // lifetime, shared rate-limit storage for #316) must survive, not be dropped.
  it("keeps the caller's keys the policy does not pin", async () => {
    const out = await probe('http://localhost:3000');
    expect(out).toMatchObject({ verificationExpiresIn: 600, rateLimitStorage: 'database' });
  }, 30_000);

  // #347: rate limits key on X-Real-IP, which the ingress overwrites with the peer
  // address. X-Forwarded-For is client-controlled, so a caller cannot switch back to it,
  // but its other `advanced` keys (cookies, trusted proxies) must survive the merge.
  it("pins the client-IP header to X-Real-IP and keeps the caller's other advanced keys", async () => {
    const out = await probe('http://localhost:3000');
    expect(out.advanced).toMatchObject({
      cookiePrefix: 'probe',
      ipAddress: { ipAddressHeaders: ['x-real-ip'], trustedProxies: ['10.0.0.0/8'] },
    });
  }, 30_000);

  it('issues an httpOnly, SameSite=Lax session cookie, Secure whenever the portal is served over https', async () => {
    const [https, http] = await Promise.all([
      probe('https://portal.example.com'),
      probe('http://localhost:3000'),
    ]);
    expect(https.cookie).toMatchObject({ httpOnly: true, sameSite: 'lax', secure: true });
    // Browsers drop a Secure cookie set over plain http, so local dev keeps it off.
    expect(http.cookie).toMatchObject({ httpOnly: true, sameSite: 'lax' });
    expect(http.cookie.secure).toBeFalsy();
  }, 30_000);
});
