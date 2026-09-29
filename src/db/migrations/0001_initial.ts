import { type Kysely, sql } from 'kysely';

/**
 * BetterAuth's tables for the plugin set in src/auth/config.ts (organization,
 * org-owned api keys), emitted by `npx auth@1.7.6 generate` and pasted verbatim.
 * They keep BetterAuth's column names; its Kysely adapter expects them. A plugin
 * added to `createAuth()` needs its tables in a new migration, generated the
 * same way. Never run `auth migrate` against a deployed database (ADR 0001 §2).
 */
const BETTER_AUTH = [
  `create table "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" boolean not null, "image" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null)`,
  `create table "session" ("id" text not null primary key, "expiresAt" timestamptz not null, "token" text not null unique, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade, "activeOrganizationId" text)`,
  `create table "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, "scope" text, "password" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null)`,
  `create table "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" timestamptz not null, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null)`,
  `create table "organization" ("id" text not null primary key, "name" text not null, "slug" text not null unique, "logo" text, "createdAt" timestamptz not null, "metadata" text)`,
  `create table "member" ("id" text not null primary key, "organizationId" text not null references "organization" ("id") on delete cascade, "userId" text not null references "user" ("id") on delete cascade, "role" text not null, "createdAt" timestamptz not null)`,
  `create table "invitation" ("id" text not null primary key, "organizationId" text not null references "organization" ("id") on delete cascade, "email" text not null, "role" text, "status" text not null, "expiresAt" timestamptz not null, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "inviterId" text not null references "user" ("id") on delete cascade)`,
  `create table "apikey" ("id" text not null primary key, "configId" text not null, "name" text, "start" text, "referenceId" text not null, "prefix" text, "key" text not null, "refillInterval" integer, "refillAmount" integer, "lastRefillAt" timestamptz, "enabled" boolean, "rateLimitEnabled" boolean, "rateLimitTimeWindow" integer, "rateLimitMax" integer, "requestCount" integer, "remaining" integer, "lastRequest" timestamptz, "expiresAt" timestamptz, "createdAt" timestamptz not null, "updatedAt" timestamptz not null, "permissions" text, "metadata" text)`,
  `create index "session_userId_idx" on "session" ("userId")`,
  `create index "account_userId_idx" on "account" ("userId")`,
  `create index "verification_identifier_idx" on "verification" ("identifier")`,
  `create index "member_organizationId_idx" on "member" ("organizationId")`,
  `create index "member_userId_idx" on "member" ("userId")`,
  `create index "invitation_organizationId_idx" on "invitation" ("organizationId")`,
  `create index "invitation_email_idx" on "invitation" ("email")`,
  `create index "apikey_configId_idx" on "apikey" ("configId")`,
  `create index "apikey_referenceId_idx" on "apikey" ("referenceId")`,
  `create index "apikey_key_idx" on "apikey" ("key")`,
];

/**
 * IRIS's tenant tables (ADR 0001 §2): `org_id NOT NULL` and an index that leads
 * with it, on every one. Columns are the minimum each table's owner issue builds
 * on (#254 runs, #263 usage, #344 provider keys, #361 audit); those issues extend
 * them in later migrations. Deleting an org is #349's job, so org foreign keys
 * do not cascade.
 */
const IRIS = [
  // `unique (org_id, id)` is the target of the composite foreign keys below, so
  // a row can only reference a run of its own org.
  `create table runs (
    id uuid primary key default gen_random_uuid(),
    org_id text not null references organization (id),
    kind text not null check (kind in ('a11y', 'visual')),
    status text not null default 'queued'
      check (status in ('queued', 'running', 'succeeded', 'failed', 'canceled')),
    created_at timestamptz not null default now(),
    started_at timestamptz,
    finished_at timestamptz,
    unique (org_id, id)
  )`,
  `create table run_results (
    id uuid primary key default gen_random_uuid(),
    org_id text not null,
    run_id uuid not null,
    url text,
    passed boolean,
    result jsonb,
    created_at timestamptz not null default now(),
    foreign key (org_id, run_id) references runs (org_id, id) on delete cascade
  )`,
  `create index run_results_org_id_run_id_idx on run_results (org_id, run_id)`,
  // Written in the same transaction as the work it meters; the idempotency key
  // makes a retried write a conflict, not a second charge (ADR 0001 §6). A billing
  // record: its run cannot be deleted under it until #349 decides retention.
  `create table usage_events (
    id uuid primary key default gen_random_uuid(),
    org_id text not null references organization (id),
    run_id uuid,
    kind text not null
      check (kind in ('browser_minutes', 'text_call', 'vision_call', 'agent_turn')),
    quantity numeric not null check (quantity >= 0),
    billing_mode text not null check (billing_mode in ('byok', 'managed')),
    idempotency_key text not null,
    created_at timestamptz not null default now(),
    unique (org_id, idempotency_key),
    foreign key (org_id, run_id) references runs (org_id, id)
  )`,
  `create index usage_events_org_id_created_at_idx on usage_events (org_id, created_at)`,
  `create table provider_keys (
    id uuid primary key default gen_random_uuid(),
    org_id text not null references organization (id),
    provider text not null check (provider in ('openai', 'anthropic')),
    ciphertext bytea not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (org_id, provider)
  )`,
  // Actors are plain ids, not foreign keys: an audit entry outlives the user or key.
  `create table audit_log (
    id bigint generated always as identity primary key,
    org_id text not null references organization (id),
    actor_user_id text,
    actor_api_key_id text,
    action text not null,
    target text,
    metadata jsonb,
    created_at timestamptz not null default now()
  )`,
  `create index audit_log_org_id_created_at_idx on audit_log (org_id, created_at)`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of [...BETTER_AUTH, ...IRIS]) await sql.raw(statement).execute(db);
}
