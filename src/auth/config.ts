import { apiKey } from '@better-auth/api-key';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { organization } from 'better-auth/plugins';

/**
 * The one BetterAuth configuration shared by `apps/portal` and `iris-api`
 * (ADR 0001 §4), so neither owns a second user table.
 *
 * The plugin set lives here because both sides must agree on it, and because it
 * decides the schema: migration 0001 (#248) is `auth generate` over this set, so
 * adding a plugin means a new migration too. API keys are org-owned (ADR §4). The caller
 * supplies what differs per process (secret, base URL, database). `secret` and
 * `baseURL` are required: omitted, better-auth reads `BETTER_AUTH_*` from the
 * environment or, outside production, signs sessions with a built-in secret.
 *
 * `better-auth` is ESM-only. This CommonJS build loads it through Node's
 * `require(esm)`, which the `engines` floor enables by default. Jest's sandboxed
 * `require` does not implement that, so the test spawns a real Node process.
 */
/** One outgoing account email: verification or password reset. */
export interface AuthEmail {
  to: string;
  subject: string;
  text: string;
}

/**
 * Account policy (#249, ADR 0001 §4). It is applied after the caller's options, so a
 * caller cannot relax it:
 * - email + password, and no session until the address is verified
 * - verification mail on sign-up, signed in once the link is followed
 * - a password reset revokes every other session
 * - rate limits in every environment (BetterAuth turns them on only in production).
 *   Its built-in rules cover the auth routes: sign-in/up 3 per 10s, reset and
 *   verification mail 3 per 60s.
 *
 * Session cookies are httpOnly and SameSite=Lax, and Secure whenever `baseURL` is https.
 * Those are BetterAuth's defaults given a `baseURL`, which is why `baseURL` is required.
 * The test pins them.
 *
 * ponytail: in-memory rate-limit counters, correct for one portal process. Use
 * `storage: 'database'` (a new migration) once the portal runs several (#316).
 */
function accountPolicy(sendEmail: (email: AuthEmail) => Promise<void>) {
  return {
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: ({ user, url }: { user: { email: string }; url: string }) =>
        sendEmail({
          to: user.email,
          subject: 'Reset your IRIS password',
          text: `Someone asked to reset the password for this IRIS account.\n\nSet a new one here: ${url}\n\nIf that was not you, ignore this email and the password stays as it is.`,
        }),
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: ({ user, url }: { user: { email: string }; url: string }) =>
        sendEmail({
          to: user.email,
          subject: 'Verify your IRIS email address',
          text: `Confirm this address to finish creating your IRIS account:\n\n${url}\n\nIf you did not sign up, ignore this email.`,
        }),
    },
    rateLimit: { enabled: true },
  } satisfies Partial<BetterAuthOptions>;
}

export function createAuth(
  options: Omit<BetterAuthOptions, 'plugins'> & {
    secret: string;
    baseURL: string;
    /** Delivers verification and password-reset mail. Required: no mail means no accounts. */
    sendEmail: (email: AuthEmail) => Promise<void>;
  },
) {
  const { sendEmail, ...rest } = options;
  return betterAuth({
    ...rest,
    ...accountPolicy(sendEmail),
    plugins: [organization(), apiKey({ references: 'organization' })],
  });
}
