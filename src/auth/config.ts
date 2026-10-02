import { apiKey } from '@better-auth/api-key';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { APIError, createAuthMiddleware, getIP } from 'better-auth/api';
import { Kysely, PostgresDialect } from 'kysely';
import type { Pool } from 'pg';
import { organization } from 'better-auth/plugins';
import { createAccessControl } from 'better-auth/plugins/access';
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from 'better-auth/plugins/organization/access';
import { recordCurrentAcceptance } from '../legal/acceptance';
import { ACCEPTED_TERMS } from '../legal/versions';
import { log, type LogLevel } from '../log';

/** One outgoing account email: verification or password reset. */
export interface AuthEmail {
  to: string;
  subject: string;
  text: string;
}

/**
 * Account policy (#249, ADR 0001 §4). It is merged key by key into the caller's
 * `emailAndPassword`, `emailVerification`, `rateLimit` and `advanced.ipAddress`, with
 * the policy's keys winning, so a caller cannot relax the settings below but can add
 * others. It does not lock `trustedOrigins` or any other `advanced` key.
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
 * - the client IP (rate-limit key) comes from `X-Real-IP` only (#347). The ingress
 *   (deploy/nginx/iris.conf) overwrites it with the peer address; `X-Forwarded-For`
 *   is whatever the client sent, and rotating it used to pick a fresh counter. So the
 *   portal must be reachable only through the ingress (loopback bind, never a published
 *   or public port): in production a request without the header shares one counter per
 *   path with every other such request (`no-trusted-ip`), and any process that can
 *   reach the port can name any `X-Real-IP`.
 *
 * ponytail: counters are in memory, which holds for one portal process; use
 * `storage: 'database'` (a new migration) for several (#316).
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
    // BetterAuth applies no rate limit to a request it has no IP for, so tracking stays on.
    // IPv6 clients are keyed per /64 (BetterAuth's default, pinned), like the ingress's
    // zones: per address, a /64 holder could rotate past the sign-in limits.
    ipAddress: { ipAddressHeaders: ['x-real-ip'], disableIpTracking: false, ipv6Subnet: 64 },
  } satisfies Partial<BetterAuthOptions> & {
    ipAddress: NonNullable<BetterAuthOptions['advanced']>['ipAddress'];
  };
}

/**
 * Refusals of a key that is simply not usable: unknown, disabled, expired, used up. The
 * api-key plugin logs each at ERROR ("Failed to validate API key"), so on the hosted
 * server any client sending bad keys filled the error log (#341). They are info here.
 */
const EXPECTED_KEY_REFUSALS = new Set([
  'INVALID_API_KEY',
  'KEY_NOT_FOUND',
  'KEY_DISABLED',
  'KEY_EXPIRED',
  'USAGE_EXCEEDED',
]);

/**
 * BetterAuth's log calls, routed into the IRIS logger (#275). Expected key refusals
 * (an `APIError` with one of the codes above) drop to info; anything else at error, such
 * as a database failure while validating a key, stays at error. Of the arguments only
 * strings and error messages are kept: BetterAuth may pass rows (users, sessions).
 * BetterAuth's own threshold stays at its default, warn.
 */
function betterAuthLog(level: LogLevel, message: string, ...args: unknown[]): void {
  const code = (args[0] as { body?: { code?: unknown } } | undefined)?.body?.code;
  const expected = typeof code === 'string' && EXPECTED_KEY_REFUSALS.has(code);
  const detail = args
    .map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : undefined))
    .filter((a) => a !== undefined);
  log(level === 'error' && expected ? 'info' : level, `better-auth: ${message}`, {
    ...(typeof code === 'string' && { code }),
    ...(detail.length && { err: detail.join('; ') }),
  });
}

/**
 * Org roles with an `apiKey` resource (#340), and a `providerKey` one for BYOK keys (#344). The api-key plugin checks it for every
 * org-owned key operation, and BetterAuth's default roles do not have it, so without
 * it only the org's creator could manage keys. Owners and admins manage keys; members
 * can see the list (names and first characters, never a key) but not change it.
 */
const ac = createAccessControl({
  ...defaultStatements,
  apiKey: ['create', 'read', 'update', 'delete'],
  // The org's own AI provider keys (BYOK, #344). Members see which are configured.
  providerKey: ['create', 'read', 'delete'],
} as const);
const keyManager = {
  apiKey: ['create', 'read', 'update', 'delete'] as const,
  providerKey: ['create', 'read', 'delete'] as const,
};
const roles = {
  owner: ac.newRole({ ...ownerAc.statements, ...keyManager }),
  admin: ac.newRole({ ...adminAc.statements, ...keyManager }),
  member: ac.newRole({ ...memberAc.statements, apiKey: ['read'], providerKey: ['read'] }),
};

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
  options: Omit<BetterAuthOptions, 'plugins' | 'databaseHooks' | 'hooks' | 'logger'> & {
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
    // Through the IRIS logger: JSON in hosted mode, expected key refusals at info (#275).
    logger: { log: betterAuthLog },
    emailAndPassword: { ...rest.emailAndPassword, ...policy.emailAndPassword },
    emailVerification: { ...rest.emailVerification, ...policy.emailVerification },
    rateLimit: { ...rest.rateLimit, ...policy.rateLimit },
    // One level deeper: replacing `advanced` would drop the caller's cookie and proxy keys.
    advanced: {
      ...rest.advanced,
      ipAddress: { ...rest.advanced?.ipAddress, ...policy.ipAddress },
    },
    hooks: {
      // Sign-up must carry the current versions of the terms (#276). A client that skips
      // the checkbox, or names an old version, is refused here, not in the form.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/sign-up/email') return;
        if ((ctx.body as { acceptedTerms?: unknown } | undefined)?.acceptedTerms !== ACCEPTED_TERMS)
          throw new APIError('BAD_REQUEST', {
            code: 'TERMS_NOT_ACCEPTED',
            message: 'Accept the Terms of Service and Acceptable Use Policy to create an account.',
          });
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/sign-up/email') return;
        const userId = (ctx.context.returned as { user?: { id?: string } } | undefined)?.user?.id;
        if (!userId) return;
        const source = ctx.request ?? (ctx.headers ? { headers: ctx.headers } : undefined);
        const ip = source ? getIP(source as Request, ctx.context.options) : null;
        // The user exists already: a failed write is logged, and the portal asks for
        // the acceptance again at the next page (/accept-terms) rather than losing it.
        await recordCurrentAcceptance(termsDb(rest.database), userId, ip).catch((err) =>
          log('error', 'recording terms acceptance failed', { err: String(err?.message ?? err) }),
        );
      }),
    },
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
        // owner, admin, member, as BetterAuth defines them plus `apiKey` (above).
        // Owners and admins invite; members do not.
        ac,
        roles,
        sendInvitationEmail: ({ id, email, organization: org, inviter }) =>
          sendEmail({
            to: email,
            subject: `Join ${org.name} on IRIS`,
            text: `${inviter.user.name} invited you to join ${org.name} on IRIS.\n\nLog in, or create an account with this address, then open: ${new URL(`/accept-invitation/${id}`, rest.baseURL)}\n\nIf you were not expecting this, ignore this email.`,
          }),
        requireEmailVerificationOnInvitation: true,
        cancelPendingInvitationsOnReInvite: true,
        // runs, usage and keys reference the org with no cascade: deleting one is
        // offboarding, which decides what happens to that data (#349).
        disableOrganizationDeletion: true,
      }),
      apiKey({
        references: 'organization',
        // Hashed at rest and returned once, by create (the plugin's defaults). The
        // prefix lets secret scanners and people recognise a leaked key.
        defaultPrefix: 'iris_',
        // The list shows each key's first characters. The default 6 would be the prefix
        // plus one random character, which cannot tell keys apart.
        startingCharactersConfig: { charactersLength: 11 },
        requireName: true,
        // The plugin's limiter defaults to 10 verifications a day and copies that onto
        // each key as it is created. Per-key limits are #342's; until then, none.
        rateLimit: { enabled: false },
      }),
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

/** Kysely over whichever database the caller gave BetterAuth: its own `{ db }` or a `pg` pool. */
function termsDb(database: BetterAuthOptions['database']): Kysely<unknown> {
  if (database && 'db' in database && database.db) return database.db as Kysely<unknown>;
  if (database && 'query' in database)
    return new Kysely({ dialect: new PostgresDialect({ pool: database as unknown as Pool }) });
  throw new Error('createAuth needs a pg Pool or a Kysely database to record terms acceptance');
}
