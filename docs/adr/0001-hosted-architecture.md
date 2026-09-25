# ADR 0001 — Hosted SaaS Architecture

**Status:** Accepted
**Date:** 2026-09-25
**Issue:** [#231](https://github.com/frankbria/iris/issues/231) (P0.3)
**Supersedes:** decision 3 of [integration-surfaces.md](../integration-surfaces.md) (the RPC server is "frozen"), for the hosted product only

## Context

IRIS is a local, single-user tool. The PRD's model is bring-your-own-key
([prd.md](../prd.md), "BYOK"), the user stories describe a CLI on the developer's
machine, and the only network surface, the WebSocket JSON-RPC server in
`src/protocol.ts`, was frozen as legacy. It authenticates every client with one
shared token.

The 2026-09-25 SaaS launch review turned that into 99 issues (Cycle 4 in
[plans/README.md](../../plans/README.md)). About half of them build a platform that
does not exist yet: accounts, tenancy, storage, billing, ingress. None of those
issues can be designed until someone has written down what is hosted, how it
authenticates, where tenant data lives and how usage is paid for. This ADR does
that.

The product owner made two decisions on 2026-09-25, and this record builds on them:

- **AI billing:** BYOK *plus* a managed-key credit tier.
- **Launch surface:** an authenticated API plus a minimal portal.

## Decision

### 1. Topology: three processes, one database, one bucket

```
                 TLS reverse proxy (#347)
                 /                      \
     apps/portal (Next.js)          iris-api (Node, this package)
     - BetterAuth routes            - REST  /v1/...   jobs, results, Stripe webhook
     - orgs, keys, BYOK, billing    - WSS   /v1/rpc   interactive browser sessions
            |                              |                     |
            |                    iris-worker (same image)        |
            |                    - claims queued jobs            |
            |                    - runs a11y / visual in the     |
            |                      hardened browser              |
            |                    - reports usage to Stripe       |
            \______________________________|_____________________/
                                           |
                          PostgreSQL  +  S3-compatible object storage
```

- **`iris-api`** is the existing package's server, grown from `iris connect`. A
  single HTTP server carries the REST API and upgrades `/v1/rpc` to the existing
  JSON-RPC-over-WebSocket protocol. Interactive RPC sessions run their browser
  *in this process*. They are stateful and bound to one socket, so a queue in
  between would add nothing.
- **`iris-worker`** is the same container image started with a different command.
  It runs submitted a11y and visual-diff jobs, which are batch work and should not
  compete with interactive sessions for the API's event loop or browser pool. It
  also runs the periodic Stripe meter report (#264), holding a Postgres advisory
  lock so that only one worker sends it.
- **`apps/portal`** is a Next.js app built from the Nova preset (#247). It is where
  a human signs up, manages an org, creates API keys, stores BYOK provider keys
  and handles billing. It reads tenant data straight from Postgres, through the
  same store modules the API uses. It never calls the public API, so it never
  needs an API key of its own.
- **Job queue = the `runs` table.** A submitted job is a `runs` row with
  `status = 'queued'`, and a worker claims it with `SELECT … FOR UPDATE SKIP
  LOCKED`. That avoids Redis and any second queue that could disagree with run
  history. *Revisit when* claim contention shows up in the metrics (#275), or
  when jobs need scheduling beyond "run next".
- Containers follow the existing constraints in CLAUDE.md ("Container
  Deployment"): they bind `0.0.0.0` inside, the host publishes loopback only, and
  the reverse proxy is the only public listener. Host and environment details stay
  in the operator's runbook, never in this repo.

### 2. Tenant data: PostgreSQL, org-scoped rows

- All hosted tenant data lives in **PostgreSQL**. SQLite (`~/.iris/iris.db`, the
  cost ledger, the vision cache) stays the **local-mode** store and is never
  used in hosted mode.
- **Row-level tenancy.** Every tenant table has `org_id NOT NULL` and an index
  that leads with `org_id`. Every hosted read path takes an org scope as a
  required, typed parameter, never an optional filter. Starting with one database
  per tenant was rejected: it multiplies migrations and backups before the first
  customer exists.
- **Storage seam.** Each persistent concern gets one interface with a local and a
  hosted implementation (`HistoryStore` #254, cost ledger and vision cache #255,
  `ArtifactStore` #257), chosen once at startup from `IRIS_HOSTED`. Business
  logic never branches on the mode.
- **SQL layer: Kysely + `pg`.** BetterAuth's built-in adapter is Kysely, so one
  query builder serves both the auth tables and IRIS's own tables. An ORM
  (Prisma, Drizzle) would add a second schema language for no gain.
- **Migrations: the Kysely `Migrator`**, run over one ordered directory of
  migration files (#248). BetterAuth's tables are emitted once with
  `npx auth generate` and committed as an ordinary migration. `auth migrate` is
  never run against a deployed database, so there is exactly one migration path.
  Migrations run as a gated deploy step (#273), never at process boot. The
  existing `migrations/*.sql` files are SQLite, are never applied, and are
  handled by #321.
- **Initial schema** (#248): BetterAuth user, session, organization, member and
  apikey tables, plus `runs`, `run_results`, `usage_events`, `provider_keys` and
  `audit_log`.

### 3. Artifacts: private S3-compatible object storage

- Screenshots, diff images, baselines and reports go to **S3-compatible object
  storage**: MinIO in development and staging, any S3-compatible service in
  production (the vendor is left to #273). The bucket is private.
- Keys: `org/<org_id>/project/<project_id>/run/<run_id>/…` for run artifacts and
  `org/<org_id>/project/<project_id>/baselines/…` for baselines (#257). The first
  path segment is the tenant boundary.
- Clients get short-lived **signed URLs**. Objects are never public, and an
  artifact is never proxied without an org check.
- Hosted baselines belong to a **project** (keyed by project + page + device) and
  change only through an explicit approval (#268). Git-branch baselines
  (`src/visual/baseline.ts`) remain a local-mode feature.

### 4. Identity: BetterAuth, one user store for portal and API

- **BetterAuth** is the only identity source. The portal hosts its routes, and
  one shared auth configuration (database, plugins) is imported by both the
  portal and `iris-api`, so neither owns a second user table.
- Humans use email + password with verification and password reset (#249).
  Portal sessions use secure, httpOnly, sameSite cookies.
- The **organization plugin** provides orgs, invitations and the roles
  owner / admin / member (#250). The org is the tenant, and a user can belong to
  several.
- The **api-key plugin** issues **org-owned** keys, hashed at rest and shown once
  (#340). `iris-api` authenticates `Authorization: Bearer <key>` with
  `auth.api.verifyApiKey` and binds the resulting `orgId` / `keyId` to the
  connection and to every session, job, usage row and audit entry it creates
  (#341).
- Local mode keeps the existing `IRIS_CONNECT_TOKEN` shared token. In hosted mode
  that token is disabled.
- *Known risk:* IRIS builds as CommonJS. Loading BetterAuth from it relies on
  Node's `require(esm)`, which the `engines` floor (`^22.13 || >=24`) enables by
  default. #247 must prove this on its first commit. If it fails, the shared auth
  config moves into an ESM workspace package that both apps import.

### 5. `IRIS_HOSTED=1`: one switch, read once, fails closed

`IRIS_HOSTED=1` is read once at startup and cannot be relaxed afterwards by a
CLI flag, a config file or a client request. It means:

- **Strict URL policy on every navigation path.** RPC sessions, the job runners
  and anything else that drives a browser refuse private, reserved and metadata
  destinations. That covers redirects and sub-resources, and DNS resolution is
  enforced at an egress layer (#334, #335, #336). In local mode today's
  permissive default is unchanged.
- **A hardened browser.** Every browser comes from one shared launch factory with
  Chromium's sandbox enabled (#331), inside a least-privilege container (#332).
- **No ambient configuration.** No cwd `.env` and no `~/.iris/config.json`.
  Configuration comes from the process environment and mounted secrets only
  (#358).
- **No local paths.** No `file:` URLs, no request-supplied output paths and no
  writes outside the data directory and temp. History goes to Postgres and
  artifacts to object storage (#241, #254, #257).
- **Per-tenant auth and credentials.** API keys replace the shared token, and AI
  provider credentials are resolved per request (§6). Tenant work never falls
  back to process-wide `*_API_KEY` variables (#258).
- **Fail closed.** The process refuses to start if hosted-required configuration
  is missing: database URL, object storage, auth secret, and the key-encryption
  master key.
- **Local-only features are unavailable**, as listed in §7.

### 6. Billing: BYOK per org, plus managed-key credits on Stripe

Each org runs AI calls in one of two modes, stored as an org setting:

| | **BYOK** | **Managed credits** |
|---|---|---|
| Whose provider key | The org's own, envelope-encrypted at rest (#344) | IRIS's |
| Who pays the AI provider | The customer, directly | IRIS, recovered through Stripe |
| Ledger `billing_mode` | `byok`, recorded but not billed as AI spend | `managed`, billed |
| Budget gate | Plan limits only | Plan limits **and** remaining credits, reserved before the call (#244, #346) |

- **Resolution per call:** the org's mode decides. A managed call with no credits
  left falls back to the org's BYOK key for that provider if one exists, and
  otherwise fails with a clear error (#346). The reverse never happens: a BYOK
  call never silently switches to managed, because that would bill the customer
  for spend they did not choose.
- **Platform usage** (browser minutes, runs, agent turns, vision calls, storage)
  is metered in both modes and limited by the org's plan (#260, #263).
- **`usage_events` in Postgres is the system of record.** Each row is written in
  the same transaction as the work it meters and carries an idempotency key.
  Stripe is fed *from* the ledger: managed usage goes to Stripe meters (#264) and
  is reconciled per billing period.
- **Stripe** holds customers (one per org), subscriptions (Checkout), and
  self-service plan and card changes (Customer Portal) (#261). Subscription state
  is taken **only** from signature-verified, idempotently processed webhooks
  (#345), never from a redirect. IRIS never stores card data.
- Plans are defined in code (for example free / pro / team) and resolved with
  `getEntitlements(orgId)` (#260). Money moves to integer micro-units in #318.

### 7. What is hosted at launch

| Surface | Hosted at launch | Notes |
|---|---|---|
| JSON-RPC over **WSS** (`/v1/rpc`) | **Yes** | Existing methods, behind API-key auth, limits and rate caps (#338, #341, #342). New methods only through the backlog (e.g. #312). |
| **a11y job API** | **Yes** | Submit → job id → status/result (#267) |
| **Visual-diff job API** | **Yes** | Project baselines + approval (#268) |
| **Results API** | **Yes** | Runs, run detail, signed artifact URLs (#269) |
| **Stripe webhook** | **Yes** | #345 |
| **Portal** | **Yes** | Account, org, keys, BYOK, runs, usage/billing (#249–#250, #340, #344, #270, #271) |
| **MCP stdio server** (`iris-mcp`) | **No, stays local** | stdio is a local transport. Hosted MCP over HTTP is post-launch (#314). |
| **CLI** (`run`, `watch`, `visual-diff`, `a11y`, `connect`) | **No, stays local** | The CLI keeps working exactly as it does today, BYOK from the user's own environment. |
| **Git-branch baselines, `watch`** | **No** | Local-mode features |

## Alternatives considered

- **Managed-only or BYOK-only AI billing:** rejected by the 2026-09-25 decision.
  Each alone loses either customers who will not share keys or customers who do
  not want to manage them.
- **A hosted identity provider** (Auth0, Clerk, and similar): rejected. BetterAuth
  keeps users, orgs and API keys in our own Postgres, with no second store to
  sync.
- **Redis or a dedicated queue:** rejected for launch. It is extra infrastructure,
  and job state would then live in two places. See the revisit trigger in §1.
- **One database per tenant:** rejected for launch (§2).
- **Artifacts in Postgres:** rejected. Large binary blobs bloat backups, and
  Postgres cannot issue signed URLs.

## Consequences

- The RPC server is **no longer frozen for the hosted product**. It gets the
  hardening, auth and limits work of Cycle 4 groups B, C and F. Decision 1 of
  integration-surfaces.md (the CLI is canonical for local assistants) and
  decision 2 (MCP is the strategic assistant bridge) still hold.
- The repo becomes a monorepo: the IRIS package stays at the root, unchanged for
  publishing, with the portal in `apps/portal` (#247).
- Every persistent concern goes behind a local/hosted interface before its hosted
  implementation lands, so local mode keeps its current behaviour and tests.
- Postgres, object storage and the reverse proxy become operational
  dependencies, with backups (#274) and observability (#275).
- This record states the target, and the issues cited in each section implement
  it. When an implementation has to deviate, it adds a dated update section here
  rather than silently diverging.

## Revisit triggers

- Job claim contention or a need for scheduled or delayed jobs → a dedicated queue.
- A customer requiring data isolation beyond rows → schema- or database-per-tenant.
- The first hosted-MCP customer → #314, and a new row in §7.
