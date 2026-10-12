import { recordAudit } from '../audit-log';
import { revokeIfCreatorLeft, revokeKeysCreatedBy } from '../member-keys';
import { apiKey } from '@better-auth/api-key';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { APIError, createAuthMiddleware, getIP, getSessionFromCtx } from 'better-auth/api';
import { Kysely, PostgresDialect, sql } from 'kysely';
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
import {
  revokeIfCreatorBanned,
  suspendedSql,
  userBannedLocked,
  userSuspensions,
} from '../org-suspension';
import { FREE_ORGS_PER_USER, freeOrgLimitReached, retractOrg } from '../billing/plans';

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
  // Making a visual result a project's new baseline (#463): owners and admins only.
  visualBaseline: ['approve'],
} as const);
const keyManager = {
  apiKey: ['create', 'read', 'update', 'delete'] as const,
  providerKey: ['create', 'read', 'delete'] as const,
  visualBaseline: ['approve'] as const,
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
  options: Omit<
    BetterAuthOptions,
    // `socialProviders` would create users through OAuth callbacks, which skip the
    // `/sign-up/email` hook that enforces the terms (#276). Adding one means enforcing
    // acceptance on that path first (e.g. in `databaseHooks.user.create.before`).
    'plugins' | 'databaseHooks' | 'hooks' | 'logger' | 'socialProviders'
  > & {
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
        if (API_KEY_WRITES.has(ctx.path)) {
          await refuseSuspendedKeyWrite(ctx, rest.database);
          return rememberDeletedKeyOrg(ctx, rest.database);
        }
        if (ctx.path === '/organization/create') {
          await refuseOrgCreateForSuspendedMember(ctx, rest.database);
          return refuseOrgCreateOverFreeLimit(ctx, rest.database);
        }
        if (ctx.path !== '/sign-up/email') return;
        if ((ctx.body as { acceptedTerms?: unknown } | undefined)?.acceptedTerms !== ACCEPTED_TERMS)
          throw new APIError('BAD_REQUEST', {
            code: 'TERMS_NOT_ACCEPTED',
            message: 'Accept the Terms of Service and Acceptable Use Policy to create an account.',
          });
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (API_KEY_WRITES.has(ctx.path)) return auditKeyWrite(ctx, rest.database);
        if (MEMBER_WRITES.has(ctx.path)) return afterMemberWrite(ctx, rest.database);
        if (ctx.path === '/organization/create')
          return undoOrgCreateOverFreeLimit(ctx, rest.database);
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
          before: async (session) => {
            await refuseBannedUser(rest.database, session.userId);
            // Defined below `auth`, whose API it needs; the hook only runs at sign-in.
            return {
              data: { ...session, activeOrganizationId: await activeOrgFor(session.userId) },
            };
          },
          // A ban that committed after the check above, before the insert, deleted the
          // user's sessions without this one (codex review): look again under its lock.
          after: (session) => dropIfBanned(rest.database, session),
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
   * belong to several. Two first sign-ins at the same moment can each create an org: these
   * server calls carry no session, so the one-free-org cap (#260) does not see them. That
   * needs two simultaneous first sign-ins and yields at most one extra free org.
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

/**
 * Every session is created through `session.create.before`, so a banned user (#457) gets
 * none: sign-in is refused, and with it everything a session reaches (invitations too).
 */
async function refuseBannedUser(
  database: BetterAuthOptions['database'],
  userId: string,
): Promise<void> {
  if (await userSuspensions(termsDb(database)).isSuspended(userId)) {
    throw new APIError('FORBIDDEN', { code: 'USER_BANNED', message: 'This account is suspended' });
  }
}

async function dropIfBanned(
  database: BetterAuthOptions['database'],
  session: { id: string; userId: string },
): Promise<void> {
  const db = termsDb(database);
  if (!(await userBannedLocked(db, session.userId))) return;
  await sql`delete from session where id = ${session.id}`.execute(db);
  throw new APIError('FORBIDDEN', { code: 'USER_BANNED', message: 'This account is suspended' });
}

/** The api-key plugin's endpoints that change an org's keys. */
const API_KEY_WRITES = new Set(['/api-key/create', '/api-key/update', '/api-key/delete']);

/**
 * The org of a key being deleted, by key id, looked up before the plugin deletes the row:
 * after it, nothing names the org the audit entry belongs to (#361). A key's org never
 * changes, so concurrent deletes of one key share the entry safely; only the delete that
 * succeeded removes it (a refused one must not take it from the one that succeeds).
 * ponytail: a refused delete of a real key leaves its entry (one small string per key).
 */
const deletedKeyOrgs = new Map<string, string>();

async function rememberDeletedKeyOrg(
  ctx: Parameters<Parameters<typeof createAuthMiddleware>[0]>[0],
  database: BetterAuthOptions['database'],
): Promise<void> {
  const keyId = (ctx.body as { keyId?: unknown } | undefined)?.keyId;
  if (ctx.path !== '/api-key/delete' || typeof keyId !== 'string') return;
  const { rows } = await sql<{ org: string | null }>`
    select "referenceId" as org from apikey where id = ${keyId}`.execute(termsDb(database));
  if (rows[0]?.org) deletedKeyOrgs.set(keyId, rows[0].org);
}

/** BetterAuth's member endpoints that change who is in an org, or their role (#408). */
const MEMBER_WRITES = new Set([
  '/organization/remove-member',
  '/organization/leave',
  '/organization/update-member-role',
]);

/**
 * A member removed, gone or given another role (#408), audited with the user who did it.
 * A member who leaves the org, or is removed, takes the API keys they created with them:
 * keys belong to the org and outlive their creator (#340), and only #361's audit log says
 * who that was. Keys made before #361 have no creator on record and stay. A role change
 * revokes nothing. Logged on failure, not thrown: the membership change already happened.
 */
async function afterMemberWrite(
  ctx: Parameters<Parameters<typeof createAuthMiddleware>[0]>[0],
  database: BetterAuthOptions['database'],
): Promise<void> {
  const returned = ctx.context.returned as
    { member?: MemberRow; userId?: string; organizationId?: string; role?: string } | undefined;
  // Remove answers { member }, leave and role change the member row; a refusal, an error.
  const member = ctx.path === '/organization/remove-member' ? returned?.member : returned;
  if (!member?.userId || !member.organizationId) return;
  const session = await getSessionFromCtx(ctx);
  const actor = { userId: session?.user.id ?? null };
  const orgId = member.organizationId;
  const target = `user:${member.userId}`;
  const db = termsDb(database);
  try {
    if (ctx.path === '/organization/update-member-role') {
      await recordAudit(db, {
        orgId,
        actor,
        action: 'member.role',
        target,
        metadata: { role: member.role },
      });
      return;
    }
    const action = ctx.path === '/organization/leave' ? 'member.leave' : 'member.remove';
    await db.transaction().execute(async (tx) => {
      const revoked = await revokeKeysCreatedBy(tx, orgId, member.userId!, actor, action);
      await recordAudit(tx, {
        orgId,
        actor,
        action,
        target,
        metadata: { revokedKeys: revoked.length },
      });
    });
  } catch (err) {
    log('error', 'failed to record a membership change', {
      action: ctx.path,
      err: String((err as Error)?.message ?? err),
    });
  }
}

interface MemberRow {
  userId?: string;
  organizationId?: string;
  role?: string;
}

/**
 * An org key created, changed or revoked, with the user who did it (#361, from #340: the
 * key row records no creator). Never the key: create's response carries the plaintext, and
 * only its id is recorded. A failed write is logged; the key change already happened.
 */
async function auditKeyWrite(
  ctx: Parameters<Parameters<typeof createAuthMiddleware>[0]>[0],
  database: BetterAuthOptions['database'],
): Promise<void> {
  const session = await getSessionFromCtx(ctx);
  const returned = ctx.context.returned as
    { id?: string; referenceId?: string; success?: boolean } | undefined;
  const body = (ctx.body ?? {}) as { keyId?: unknown };
  const deleting = ctx.path === '/api-key/delete';
  const keyId = deleting ? (typeof body.keyId === 'string' ? body.keyId : undefined) : returned?.id;
  const orgId = deleting ? keyId && deletedKeyOrgs.get(keyId) : returned?.referenceId;
  if (deleting && returned?.success !== true) return;
  if (deleting && keyId) deletedKeyOrgs.delete(keyId);
  if (!session || !keyId || !orgId) return;
  const verb = ctx.path.slice('/api-key/'.length);
  const fields =
    verb === 'update'
      ? Object.keys(body)
          .filter((k) => k !== 'keyId')
          .sort()
      : undefined;
  await recordAudit(termsDb(database), {
    orgId,
    actor: { userId: session.user.id },
    action: `api_key.${verb}`,
    target: `key:${keyId}`,
    ...(fields && { metadata: { fields } }),
  })
    // After the audit row is committed: a removal racing this create either saw that row
    // or left no membership for this check to find (#408).
    .then(() =>
      verb === 'create'
        ? revokeIfCreatorLeft(termsDb(database), orgId, session.user.id, keyId).then(
            (left) => left || revokeIfCreatorBanned(termsDb(database), orgId, session.user.id),
          )
        : false,
    )
    .catch((err) =>
      log('error', 'failed to record audit entry', {
        action: `api_key.${verb}`,
        err: String(err?.message ?? err),
      }),
    );
}

/**
 * A suspended org's keys cannot be created, changed or revoked (#348). Refused only
 * for a member of that org, so a request naming another tenant's org still gets the
 * plugin's own "not a member" and learns nothing about its state. One query: the
 * org, its suspension and the caller's membership.
 *
 * The org is the body's `organizationId` for create only. Update and delete act on
 * the key's own org whatever the body names (the plugin drops an unknown field and
 * checks `apikey.referenceId`), so for them the org comes from the key alone: naming
 * another org must not skip the check.
 */
async function refuseSuspendedKeyWrite(
  ctx: Parameters<Parameters<typeof createAuthMiddleware>[0]>[0],
  database: BetterAuthOptions['database'],
): Promise<void> {
  const session = await getSessionFromCtx(ctx);
  if (!session) return; // the endpoint refuses it
  const body = (ctx.body ?? {}) as { organizationId?: unknown; keyId?: unknown };
  const creating = ctx.path === '/api-key/create';
  const orgId = creating && typeof body.organizationId === 'string' ? body.organizationId : null;
  const keyId = !creating && typeof body.keyId === 'string' ? body.keyId : null;
  if (!orgId && !keyId) return;
  const { rows } = await sql<{ refused: boolean }>`
    with k as (
      select coalesce(${orgId}::text, (select "referenceId" from apikey where id = ${keyId})) as org)
    select ${suspendedSql(sql.ref('k.org'))} and exists (
      select 1 from member m where m."organizationId" = k.org and m."userId" = ${session.user.id}
    ) as refused from k`.execute(termsDb(database));
  if (rows[0]?.refused)
    throw new APIError('FORBIDDEN', {
      code: 'ORGANIZATION_SUSPENDED',
      message: 'This organization is suspended.',
    });
}

/**
 * A member of a suspended org cannot create another (#348): suspension is per org, and a
 * fresh org would carry new API keys straight past it. Joining an org someone else
 * invites them to stays open; that org's owner chose it. Account-level bans are a
 * separate matter.
 */
async function refuseOrgCreateForSuspendedMember(
  ctx: Parameters<Parameters<typeof createAuthMiddleware>[0]>[0],
  database: BetterAuthOptions['database'],
): Promise<void> {
  const session = await getSessionFromCtx(ctx);
  if (!session) return; // the endpoint refuses it
  const { rows } = await sql<{ refused: boolean }>`
    select exists (
      select 1 from member m where m."userId" = ${session.user.id}
        and ${suspendedSql(sql.ref('m.organizationId'))}
    ) as refused`.execute(termsDb(database));
  if (rows[0]?.refused)
    throw new APIError('FORBIDDEN', {
      code: 'ORGANIZATION_SUSPENDED',
      message: 'This organization is suspended.',
    });
}

/**
 * One free org per user (#260): a user who already owns `FREE_ORGS_PER_USER` free orgs
 * cannot create another, since each carries its own allowance. Paid orgs do not count.
 * Server calls with no session (the personal org at first sign-in, `activeOrgFor`) pass:
 * that user owns no org yet.
 */
async function refuseOrgCreateOverFreeLimit(
  ctx: Parameters<Parameters<typeof createAuthMiddleware>[0]>[0],
  database: BetterAuthOptions['database'],
): Promise<void> {
  const session = await getSessionFromCtx(ctx);
  if (!session) return;
  if (await freeOrgLimitReached(termsDb(database), session.user.id))
    throw new APIError('FORBIDDEN', {
      code: 'ORGANIZATION_LIMIT_REACHED',
      message:
        'Your free organization limit is reached. Upgrade an organization to create another.',
    });
}

/**
 * The before hook's count and the plugin's insert are not atomic: parallel creates by a
 * user with no free org can all pass it. So once the org exists, count again under a
 * per-user lock; over the cap, take the new org back (`retractOrg`: deleted, or suspended
 * if a concurrent request already attached data to it) and refuse. The lock serialises the recounts, so exactly `FREE_ORGS_PER_USER`
 * of the racing orgs survive whatever the commit order. The session the plugin pointed
 * at a removed org gets no active org, and `requireOrg()` moves it back to one the user
 * belongs to.
 */
async function undoOrgCreateOverFreeLimit(
  ctx: Parameters<Parameters<typeof createAuthMiddleware>[0]>[0],
  database: BetterAuthOptions['database'],
): Promise<void> {
  const session = await getSessionFromCtx(ctx);
  const orgId = (ctx.context.returned as { id?: string } | undefined)?.id;
  if (!session || !orgId) return;
  const undone = await termsDb(database)
    .transaction()
    .execute(async (tx) => {
      await sql`select pg_advisory_xact_lock(hashtext(${'org-create:' + session.user.id}))`.execute(
        tx,
      );
      if (!(await freeOrgLimitReached(tx, session.user.id, FREE_ORGS_PER_USER + 1))) return false;
      await retractOrg(tx, orgId);
      return true;
    });
  if (undone) throw new APIError('FORBIDDEN', ORG_LIMIT_ERROR);
}

const ORG_LIMIT_ERROR = {
  code: 'ORGANIZATION_LIMIT_REACHED',
  message: 'Your free organization limit is reached. Upgrade an organization to create another.',
};

/** Kysely over whichever database the caller gave BetterAuth: its own `{ db }` or a `pg` pool. */
function termsDb(database: BetterAuthOptions['database']): Kysely<unknown> {
  if (database && 'db' in database && database.db) return database.db as Kysely<unknown>;
  if (database && 'query' in database)
    return new Kysely({ dialect: new PostgresDialect({ pool: database as unknown as Pool }) });
  throw new Error('createAuth needs a pg Pool or a Kysely database to record terms acceptance');
}
