import { apiKey } from '@better-auth/api-key';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { organization } from 'better-auth/plugins';

/** One outgoing account email: verification or password reset. */
export interface AuthEmail {
  to: string;
  subject: string;
  text: string;
}

/**
 * Account policy (#249, ADR 0001 §4). It is merged key by key into the caller's
 * `emailAndPassword`, `emailVerification` and `rateLimit`, with the policy's keys
 * winning, so a caller cannot relax the settings below but can add others. It does
 * not lock `advanced` or `trustedOrigins`; #347 needs `advanced.ipAddress`.
 * - email + password; no session until the address is verified
 * - a verification mail on sign-up, and a fresh one on each correct-password sign-in
 *   of an unverified account. A lost or expired link, or a send that failed
 *   (BetterAuth logs a mail error rather than failing the request), is recoverable.
 * - no sign-in on verification: a mailed link must not sign a browser into whatever
 *   account sent it (login CSRF). The user logs in afterwards.
 * - a password reset revokes every other session
 * - rate limits in every environment (BetterAuth turns them on only in production).
 *   Its built-in rules cover the auth routes: sign-in/up 3 per 10s, reset and
 *   verification mail 3 per 60s.
 *
 * Session cookies are httpOnly and SameSite=Lax, and Secure whenever `baseURL` is https.
 * Those are BetterAuth's defaults given a `baseURL`, which is why `baseURL` is required.
 * The test pins them.
 *
 * ponytail: counters are per client IP from a single-value X-Forwarded-For, in memory.
 * A client can pick its own counter until the ingress overwrites that header and
 * `advanced.ipAddress` trusts only it (#347). Memory storage then holds for one portal
 * process; use `storage: 'database'` (a new migration) for several (#316).
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
      sendOnSignIn: true,
      autoSignInAfterVerification: false,
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
export function createAuth(
  options: Omit<BetterAuthOptions, 'plugins' | 'databaseHooks'> & {
    secret: string;
    baseURL: string;
    /** Delivers verification and password-reset mail. Required: no mail means no accounts. */
    sendEmail: (email: AuthEmail) => Promise<void>;
  },
) {
  const { sendEmail, ...rest } = options;
  const policy = accountPolicy(sendEmail);
  // Key by key, policy last: a caller cannot relax a pinned setting, and its other
  // keys (a shorter link lifetime, shared rate-limit storage for #316) survive.
  const auth = betterAuth({
    ...rest,
    emailAndPassword: { ...rest.emailAndPassword, ...policy.emailAndPassword },
    emailVerification: { ...rest.emailVerification, ...policy.emailVerification },
    rateLimit: { ...rest.rateLimit, ...policy.rateLimit },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => ({
            // Defined below `auth`, whose API it needs; the hook only runs at sign-in.
            data: { ...session, activeOrganizationId: await activeOrgFor(session.userId) },
          }),
        },
      },
    },
    plugins: [
      organization({
        // Default roles: owner, admin, member. Owners and admins invite; members do not.
        sendInvitationEmail: ({ id, email, organization: org, inviter }) =>
          sendEmail({
            to: email,
            subject: `Join ${org.name} on IRIS`,
            text: `${inviter.user.name} invited you to the ${org.name} organization on IRIS.\n\nLog in, or create an account with this address, then open: ${new URL(`/accept-invitation/${id}`, rest.baseURL)}\n\nIf you were not expecting this, ignore this email.`,
          }),
        requireEmailVerificationOnInvitation: true,
        cancelPendingInvitationsOnReInvite: true,
        // runs, usage and keys reference the org with no cascade: deleting one is
        // offboarding, which decides what happens to that data (#349).
        disableOrganizationDeletion: true,
      }),
      apiKey({ references: 'organization' }),
    ],
  });
  /**
   * The org a new session starts in: one the user belongs to, or, for a user with none,
   * a new org they own. This is where "an org on signup" happens. A session needs a
   * verified address, so an abandoned sign-up leaves no org, and a failed creation is
   * retried at the next sign-in rather than leaving a user with no tenant.
   *
   * ponytail: any membership will do. Remember the last active org per user once people
   * belong to several. Two first sign-ins at the same moment can each create an org;
   * that grants nothing BetterAuth's own `create` endpoint does not, and a cap on orgs
   * per user belongs to entitlements (#260).
   */
  const activeOrgFor = async (userId: string): Promise<string> => {
    const ctx = await auth.$context;
    const member = await ctx.adapter.findOne<{ organizationId: string }>({
      model: 'member',
      where: [{ field: 'userId', value: userId }],
    });
    if (member) return member.organizationId;
    const user = await ctx.internalAdapter.findUserById(userId);
    const org = await auth.api.createOrganization({
      body: {
        name: user?.name ? `${user.name}'s organization` : 'My organization',
        slug: crypto.randomUUID(),
        userId,
      },
    });
    return org.id;
  };
  return auth;
}
