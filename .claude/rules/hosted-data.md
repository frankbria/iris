---
paths:
  - "src/db/**"
  - "src/billing/**"
  - "src/history-store.ts"
  - "src/worker.ts"
  - "src/jobs-api.ts"
  - "src/artifact-store.ts"
  - "src/storage-quota.ts"
  - "src/offboarding.ts"
  - "src/audit-log.ts"
  - "src/run-reads.ts"
  - "src/visual/hosted-job.ts"
  - "docker-compose.dev.yml"
  - "__tests__/{db,billing}/**"
  - "__tests__/{api-,artifact-store,entitlements,history-store,hosted-,job-deadline,offboarding,worker-}*"
---

### Hosted Postgres and Migrations (issue #248)

Hosted tenant data lives in Postgres through Kysely + `pg` (ADR 0001 §2). SQLite
stays the local-mode store. `docker-compose.dev.yml` runs a dev Postgres on
`127.0.0.1:55432`.

- **Migrations** are `src/db/migrations/NNNN_<what>.ts`, registered by hand in the
  `MIGRATIONS` map in `src/db/migrate.ts`. The map replaces a directory scan, so
  resolution is the same under ts-node, `dist/` and the image. The Kysely Migrator
  applies migrations in name order, records them in `kysely_migration`, and on
  Postgres runs the whole pending batch in **one** transaction. Never edit an
  applied migration; add a new one. Every migration must keep the previous release
  working on the new schema (expand/contract): a production rollback runs it there,
  and `migrateToLatest()` then applies nothing (#273).
- **Every IRIS table gets `org_id NOT NULL` and an index that leads with it.**
  `__tests__/db/postgres.test.ts` checks this against the catalog, so a new table
  without them fails there. A table that references a run uses the composite key
  `(org_id, run_id) → runs (org_id, id)`, so a row cannot point at another org's
  run. BetterAuth's tables are exempt and keep its own column names.
- **BetterAuth's schema comes from its CLI.** It lives in migration 0001, the output
  of `npx auth@<better-auth version> generate` run over `createAuth()`. Adding a
  plugin to `createAuth()` means generating again and committing the difference as a
  new migration. Never run `auth migrate` against a deployed database.
- **`kysely/migration` is resolved by a types-only `paths` entry in tsconfig.**
  Kysely 0.29 moved `Migrator` there. `node10` resolution ignores `exports`, and at
  runtime Node resolves the subpath itself. Kysely is ESM-only, so it is also on
  Jest's transform allowlist.
- **Tests need `IRIS_TEST_DATABASE_URL`**, an admin URL. Each file creates and drops
  its own database. The Postgres tests are required under `CI` (the build job has a
  service container) and skipped locally when the variable is unset.
- **The pool has a 10s connect timeout.** Without it, `pg` waits forever on a host
  that accepts connections and never answers, and a deploy step hangs instead of
  failing.
- **The pool has an `error` listener** (#341). A Postgres restart ends every idle
  pooled connection, and `pg` reports that as an `error` event on the pool. With no
  listener it is an uncaught exception, and the process exits: the hosted RPC server
  dropped every tenant in the #341 demo. The pool replaces the client by itself.
- **Deploy order** (ci.yml): `pull`, then `up -d --wait postgres`, then migrate
  from the new image, then force-recreate `iris` only. A failed migration leaves the
  old container serving. The Postgres password is generated on the box **once**,
  because the volume keeps the password it was initialised with. The URL is rebuilt
  on every deploy. Both are secret files (`pg_password` for uid 70,
  `database_url` for uid 1001). Postgres publishes no port.

### Billable Usage Ledger (issue #263)

- **`usage_events`** (migration 0003): kinds `browser_minutes`, `text_call`,
  `vision_call`, `agent_turn`, `a11y_job`, `visual_job`, and `observation` (0014, #312);
  `unit_cost_usd` (the provider
  cost of one unit, AI only) and `estimated` (#243). `billing_mode` (`byok`/`managed`)
  is **required on AI kinds and must be null on platform kinds**, a check constraint,
  because the plan prices platform usage (#260). `(org_id, idempotency_key)` is unique,
  and `insertUsage` does `on conflict do nothing`, so a retried write is not a second
  charge.
- **`usageLedger(db)`** (src/billing/usage.ts): `record(orgId, events)` and
  `summary(orgId, from, to)`, giving quantity and cost per kind and billing mode, with the
  estimated part of the cost separate.
- **Transactional with the work**: `postgresHistory().forOrg().record(run, { usage })`
  writes a job's usage in the run's transaction (#267/#268 use it). An AI call is
  reported after it is settled: `createResolvedAIClient({ onUsage })`,
  `translate(…, { onUsage })` and `SmartClientConfig.onUsage` (not for cache hits)
  report `SettledAICall { operation, provider, model, costUsd, estimated }`. A failed
  report is logged, never thrown: the call is already paid for.
- **Hosted RPC** (`startServer({ usage, usageCheckpointMs })`, wired by
  `hostedServices()`): a tenant session's browser minutes are billed in segments
  (`session:<id>:<n>`), one per checkpoint (default 5 min) and a last one when it ends,
  so a crash or forced restart loses at most one interval and a session that spans a
  month is billed to both months. Minutes run from the first page, idle time included
  (Chromium is held either way), and are clamped at 0 against a backward clock.
  `BrowserSession.onEnd` runs on the first cleanup only, which matters when
  `closeBrowser` and the socket's `close` race. A settled AI call maps to its kind
  explicitly (`usageKindOf`), keyed `<operation>:<callId>`. Billing mode comes
  from the credential (#479).
- **Constraints**: `billing_mode` null iff platform kind; an AI row must carry
  `unit_cost_usd` (`usage_events_ai_cost_check`). A key already recorded is skipped and
  logged (`returning`), so a reused key cannot hide an event silently.
- **Writers not yet wired**: vision calls (hosted visual jobs run no AI) and agent
  turns: `runAgentLoop` takes the request's `{ orgId, credentials, onUsage, secrets }`
  since #428 (credentials resolved by `resolveCredentials()`, shared with `translate()`:
  omitted is no AI under IRIS_HOSTED), but no hosted surface runs it yet.

### Plans and Entitlements (issue #260)

`src/billing/plans.ts`. Limits are the owner-approved launch values (2026-10-03); prices
are on the Stripe products (#261); enforcing them at the API is #346.

- **Plans are code (`PLANS`); an org's plan is a row** in `org_plans` (migration 0009:
  `org_id` pk, `plan`, `overrides jsonb`). No row means free (self-serve free tier). No
  check constraint on `plan`: an id the code does not know resolves to free, so a new plan
  needs no migration and a bad row grants nothing.
- **`resolveEntitlements(plan, overrides)`** applies only known limit keys with valid values
  (non-negative safe integers; a boolean for `byokAllowed`). `orgEntitlements(db).get(orgId)`
  is the `getEntitlements`; `setPlan(orgId, plan, overrides?)` replaces both, so an
  upgrade drops a stale grant.
- **One free org per user** (`FREE_ORGS_PER_USER`): a `createAuth()` `hooks.before` on
  `/organization/create` refuses `403 ORGANIZATION_LIMIT_REACHED` when the user already
  owns that many orgs on free (owner role; joining someone else's org costs nothing, but an
  invited co-owner of a free org uses their allowance). BetterAuth keeps several roles as
  one comma string (`admin,owner`), so `owner` is matched as a token. It runs after the
  suspension check (`auth-apikey.test.ts` pins that order). The check and the plugin's
  insert are not atomic, so a `hooks.after` recounts under
  `pg_advisory_xact_lock(hashtext('org-create:' || userId))` and deletes the new org when
  the user is over the cap: of N parallel creates exactly one free org survives. The org
  was committed before that recount, so a concurrent request may already have attached a
  row with no cascade (a provider key); then the delete is refused and `retractOrg()`
  suspends the org instead (#348 enforcement: no keys, no jobs). Server calls with no session (the personal org at first
  sign-in) pass: that user owns nothing yet. A test that needs a second org pays for the
  first (`insert into org_plans ... 'pro'`), as `auth-apikey.test.ts` and portal
  `org.spec.ts` do.
- **No browser-minute allowance** at launch: minutes are recorded (#263), and
  `maxConcurrentSessions` caps them.

### Plan Enforcement (issue #346)

Plan limits checked before work starts. Managed AI credits are #479 (ADR 0001 §6).

- **`runsPerMonth` on job submits**: `enqueue({ monthlyRunLimit })` counts, under the same
  per-org advisory lock as the outstanding cap, this UTC month's `a11y_job` + `visual_job`
  usage (`sum(quantity)`) plus queued and running jobs (a11y 1, visual urls x devices), so
  parallel submits cannot overshoot. Over it, `RunQuotaExceededError` and the API answers
  **402** `{ error: 'Monthly run limit reached', limit, used }`. `startServer({
  entitlements })` supplies the limit; hosted `iris connect` passes `orgEntitlements(db)`.
- **Sessions**: the hosted authenticator puts the plan's `maxConcurrentSessions` on the
  principal (`Principal.maxSessions`); the RPC cap is `min(plan, operator
  maxSessionsPerOrg)`, so the operator value stays the hard ceiling. A plan change applies to
  new connections (`recheck` does not refresh it). One plan lookup per upgrade and REST
  request; a failed lookup fails closed (503), like the suspension check.
- **`runsPerMonth` is a job-API quota**: RPC `executeBrowserAction` runs are recorded but not
  counted; RPC use is bounded by concurrent sessions and metered as browser minutes. Tests that open several sessions for one real org put it on `team`
  (`api-key-auth.test.ts`).
- **`byokAllowed`**: `managedAiResolver()` (src/billing/managed-ai.ts, #479) returns no stored key
  for a plan without it.
- Not enforced yet, no hosted surface: agent turns (the loop takes a scope, #428; nothing hosted runs it), vision calls (hosted
  jobs run no AI). Storage is enforced since #315 (below).

### Tenant Audit Log (issue #361)

`src/audit-log.ts`: `recordAudit(db, { orgId, actor, action, target?, metadata? })` into
`audit_log` (migration 0001). What is recorded is listed in `docs/data-flows.md`.

- **Written on the change's own transaction** (`tx`), so neither commits without the other.
  A store that changes something audited takes the actor (`AuditActor`: `userId` /
  `apiKeyId`, plain ids with no foreign keys); `actorFrom()` reads the `user:<id>` /
  `key:<id>` form `updated_by` already uses.
- **Never a secret**: a provider key's entry names the provider, an API key's its id; an
  update records the field names it changed, not their values. Tests assert the plaintext
  is absent from every row.
- **API keys are audited by BetterAuth hooks**: the after hook on `/api-key/*` takes the
  org from the plugin's response, except for delete (the response is `{ success }` and the
  row is gone), whose org the before hook looks up by key id and passes in a module-level
  map (a key's org never changes; only a successful delete removes the entry, so a refused
  concurrent delete cannot take it). A refused write leaves no entry. A failed write is logged, not thrown: the key change
  already happened.
- **RPC sessions** are audited through `startServer({ audit })` (hosted `iris connect` wires
  it), best effort: a failed write is logged and the session goes on.
- `rewrapAll()` writes one `provider_key.rewrap` per key, in that key's update transaction,
  with no actor (an operator ran it) and the sealing master key id.
- **Read surface (#541)**: `auditPage()` (src/audit-reads.ts), the portal's `/audit` for
  owners and admins, newest first, cursor-paged, strings through `redactStrings`.
- **Kept 90 days (#541, owner decision 2026-11-08)**: `AUDIT_RETENTION_DAYS` lives in
  `src/audit-log.ts` (Kysely only, so the portal page can state it); the retention pass's
  `audit` step deletes older entries (`auditEntriesDeleted` in the report). **The log is
  also data the product reads**: `api_key.create` is the only record of a key's creator,
  and `revokeKeysCreatedBy` / `liveKeysByCreator` (#408, #457) depend on it, so that entry
  is exempt while its key exists (same org, `substr(target, 5)`) and it still names its
  creator, and goes on the first pass after the key is revoked or the creator's account
  is deleted. Before making anything else read the audit log, decide
  whether it must survive 90 days.

### Artifact Storage Quota (issue #315)

`src/storage-quota.ts`, migration 0015 (`artifact_objects`: org, key, bytes). The plan's
`artifactStorageBytes` (free 1 GB, pro 20 GB, team 100 GB) is enforced and shown.

- **Usage is recorded beside each write**: `quotaArtifacts(orgStore, db, orgId, limit)` wraps an
  org's store; `put` reserves the row first, in one statement with the check (a replaced key
  counts its new size only; over the quota it refuses with `StorageQuotaExceededError` and
  nothing is stored), then writes the object, and gives the reservation back if the write
  fails: a crash in between overcounts, never undercounts (codex review). The org FK cascades,
  so the 7-year tombstone deletion is not blocked by a purge still pending.
  `deletePrefix` forgets the matching rows, and offboarding's purge queue calls
  `forgetArtifacts` after each prefix it deletes. ponytail: concurrent writes can each
  reserve against the same total, so they can overshoot by their sum.
- **Where it bites**: a visual job submit is refused with **402** `{ error: 'Storage quota
  reached', limit, used }` when the org is at the quota (inside `enqueue`, like
  `runsPerMonth`; a11y jobs store nothing); a running visual job's write past it fails the job
  with that message (`iris worker` passes `storageQuota`); an approval's baseline copy past it
  is `over-quota` (API 402, portal message). The portal dashboard shows usage of quota.
- **Objects stored before migration 0015 have no row** and are not counted.

### Managed AI Credits (issue #479)

`src/billing/managed-ai.ts`, migration 0013 (`org_ai_settings`), ADR 0001 §6.

- **An org's AI mode** is `byok` (no row, the default) or `managed`, set by owners and admins
  on `/provider-keys` (`setAiMode`, the `providerKey` create permission). Nobody is billed
  for AI they did not choose.
- **`managedAiResolver`** is hosted `iris connect`'s `aiCredentials`: a managed org with
  credit left gets IRIS's key (`billingMode: 'managed'`); with none left, or no operator key
  configured, it falls back to its own key if its plan allows BYOK (`byok`), else no AI. A
  BYOK org never gets the managed key. Credit = plan `managedAiCreditUsdPerMonth` minus this
  UTC month's `usage_events` with `billing_mode = managed` (quantity x unit cost).
- **The RPC server records each settled call with the credential's `billingMode`**
  (`TenantCredentials` in src/protocol.ts makes it required on the resolver), no longer a
  hardcoded `byok`. A managed call that returns no actions (provider error, invalid reply) is logged and the tenant gets
  "AI translation is unavailable right now": it describes IRIS's vendor account. A BYOK
  error still reaches the org that owns the key.
- **Offboarding deletes the org's `org_ai_settings` row**: the org row survives as a
  tombstone, so its cascade never fires, and `updated_by` is a user id.
- **IRIS's key** is operator config, read once at startup: `IRIS_MANAGED_AI_PROVIDER`
  (`openai` | `anthropic`) + `IRIS_MANAGED_AI_KEY(_FILE)`; one without the other exits 3. On
  the `jest.setup.ts` scrub list.
- **Credit is reserved before the call (#482).** `managed_ai_reservations` (migration 0018):
  under `pg_advisory_xact_lock(hashtext('managed-ai:' || org))` the resolver admits a managed
  call only when this month's managed spend + live reservations + the call's worst case fit
  the credit, and inserts a reservation at that worst case (`managedCallEstimateUsd`: the
  cost tracker's `RESERVATION_CEILING` plus one input token per request character, which
  the RPC server passes as `inputChars`, at the provider's **dearest** registered rates:
  a retired default may be swapped for a pricier successor at call time, #184). The
  credential carries
  `release()`; the RPC server strips it before `translate()` and runs it in a `finally`, after
  the settled usage row is written (`onUsage` is awaited). A row older than 10 minutes stops
  counting and is deleted at the org's next admission (a crashed call). A billed call whose
  usage row failed to write is released as `{ unrecorded: true }`: its row becomes `held`
  and counts as spent until the month ends (codex review), since nothing else records it.
  A live row ends only with its TTL, so a call started before midnight UTC still counts
  after it. The estimate is a
  resolver parameter, computed in `hostedServices()`: the portal imports `managed-ai.ts`,
  and the cost tracker would bring SQLite into its bundle. Stripe reporting is #264.

### Hosted Job API (issue #267)

`iris connect` (hosted) serves REST beside the WebSocket; `iris worker` runs what it
queues. Queue = the `runs` table (migration 0004: `params jsonb`, `error text`, claim
index; 0005: `attempts`, `claim_token`, `heartbeat_at`, #435), no broker (ADR 0001 §1).

- **One `http.Server`**, handed to `WebSocketServer({ server })`. ws does not close a
  listener it was given, so `startServer` wraps `wss.close`: it stops listening the
  moment `close()` is called (REST must not keep queuing jobs during shutdown, while a
  WS client lingers) and calls back after both ws and the listener have closed. Plain
  HTTP gets 426 as before unless `jobs` is set (which requires `authenticate`).
- **REST verification shares the upgrades' `verifying` count** (`admit()`): past
  `maxConnections` pending verifications a REST request gets 503 + `Retry-After: 1`
  without calling `verify`, so a bad-key flood cannot pile onto the auth pool. Only pending
  verifications count, not idle WS sockets.
- **`maxQueuedJobsPerOrg`** (default 10; queued + running): `enqueue` counts and inserts in
  one transaction under `pg_advisory_xact_lock(hashtext(org_id))`; over it, 429 `Too many
  queued jobs`. Without it one org could fill the global FIFO.
- **Same key auth and rate buckets as RPC.** REST charges the key and org buckets (429
  with `Retry-After`); a 401 or 503 is answered before anything is charged. No CORS.
- **A URL with credentials (`user:pw@`) is a 400.** Params and results are readable by the
  whole org, so basic-auth pages cannot be scanned through the API.
- **`postgresJobs(db)`** (src/history-store.ts): `forOrg(scope)` gives the API
  `enqueue` / `get`; `claim` / `finish` / `fail` are worker-only and cross-tenant.
  `claim` is `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1)`.
  `finish` writes status, summary, results and the `a11y_job` usage (`job:<id>`, no
  billing mode) in one transaction, and only for a job still `running`.
- **Status is the run's verdict**, as for `record()`: a scan that breaches `failOn`
  is `failed` with `results` and no `error`. A job that could not run is `failed` with
  `error` (bounded, userinfo stripped) and no results, and **no usage**.
- **History lists finished runs only** (`finished_at is not null`); a queued or running
  job is visible through `jobs.get` alone.
- **The worker needs hosted mode** (exit 2 without `IRIS_HOSTED`): the runner's
  `urlPolicy` default and the egress proxy are what keep tenant URLs off internal hosts.
  A page that fails navigation fails the whole job (one error, not per page): the runner
  itself records a failing page and goes on (#287), and `runA11y` throws its error. Jobs set
  `failOnHttpError`: the egress proxy answers a plain-HTTP request to an internal address
  with a 403 *document*, which would otherwise be scanned and billed as a success.
  A result that cannot be stored is recorded as a generic error; the detail is logged.
- **Claims, heartbeats and the reaper (#435).** `claim` bumps `attempts`, sets a fresh
  `claim_token` and `heartbeat_at`. `finish`/`fail` write only for `status = 'running'`
  and their own token and return `false` (nothing written, no usage) when the claim was
  lost; the worker logs that, never throws. `processNextA11yJob` heartbeats every 30 s
  while a job runs (a failed write is logged, the job continues). `reapStuck({ staleMs =
  180 s, maxAttempts = 3 })` runs before every claim in `runWorker`, as one statement over
  `FOR UPDATE SKIP LOCKED` rows: requeue (`queued`, claim/heartbeat/`started_at` cleared)
  while `attempts < maxAttempts`, else `failed` with "The job was interrupted too many
  times" and no usage. A requeued job reads `queued`, `startedAt: null`. A running row
  with no heartbeat (pre-0005) is judged by `started_at`. A reaper error is logged and
  the loop continues. A scan that is legitimately slower than `staleMs` without beating
  (a hung event loop) is reaped too; the old claim's late write is then refused.
  A reaped worker's heartbeat stops after its first "claim lost" (said once), and a
  heartbeat answered while the outcome is being written is ignored (it waited on
  finish's row lock). `runWorker` refuses `heartbeatMs * 2 >= staleMs`. Migration 0005
  sets `lock_timeout = 5s`: its exclusive lock on `runs` must not queue behind a long
  transaction while the old release serves. A browser that hangs while the worker's event
  loop still beats is never reaped; the job deadline ends it instead (#442, below). During a rollout, a pre-0005 worker finishes
  without a token check until it is recreated (seconds; usage stays idempotent).
  Polling, not LISTEN/NOTIFY.
- **Every job has a deadline (#442)**: `jobDeadlineMs(job)` (src/worker.ts) is pages x
  `A11Y_PAGE_BUDGET_MS` (120 s) + 60 s for a11y, `JOB_DEADLINE_MS` + 5 min for visual,
  capped at `MAX_JOB_MS` (30 min). Past it, `processNextJob` closes every browser the
  process holds (`openBrowsers()` in src/browser.ts, a registry `launchBrowser()` fills;
  the worker runs one job at a time), each close bounded at 10 s, and fails the job with
  `The job timed out` and no usage. The run's promise may settle later; it is ignored, and
  the run's `AbortSignal` is aborted first: `runVisualJob` checks it before every artifact
  write and before seeding a baseline (codex review), so a write blocked past the deadline
  cannot be followed by a baseline for a job already failed.
  The worker copies the runners' budgets rather than importing them (as `DEFAULT_STALE_MS`):
  `job-deadline.test.ts` pins the copies.
- **Tests**: set `process.env.IRIS_HOSTED = '1'` at the top of the file and start
  `hostedEgressProxy({ lookup, connect })` before the first launch; no isolateModules is
  needed, because the worker loads the runner lazily.

### Hosted Visual Jobs (issue #268)

`POST /v1/visual/jobs { project, urls, devices?, threshold? }` beside the a11y route (same
auth, buckets, body cap, per-org outstanding cap); `iris worker` runs them with
`runVisualJob` (src/visual/hosted-job.ts). ADR 0001 §3: baselines belong to a project
and change only through approval; git-branch baselines stay local.

- **A project is a caller-chosen id** (`[A-Za-z0-9_-]{1,64}`), no table of its own:
  `visual_baselines` (migration 0011) is keyed `(org_id, project, name)` with
  `name = artifactName(page, device)`; `(org_id, run_id) -> runs` sets null when the run
  is pruned. Org purge deletes the rows and objects (#349, #472).
- **A project's first screenshot of a page becomes its baseline** (`approved_by =
  'first-run'`, result `newBaseline: true`, passes), seeded **insert-only**
  (`insertIfAbsent`): of two racing jobs one seeds and the other compares with it, and a
  stale (reaped) job never overwrites a baseline or an approval. Baseline images are
  immutable: `baselineObjectKey()` adds the run (`<name>--<12 hex>`), so an old run's link
  keeps showing the image it was compared with. After that a run only diffs;
  `POST /v1/runs/:id/results/:position/approve` copies that result's current image to the
  baseline key and replaces the row (`approved_by` = the key id). 404 for another org or
  position, 409 for a non-visual result or one whose screenshot is gone.
- **Every attempt writes its own images**: names carry 12 hex of the claim token
  (`<name>--<tag>`, seeded baselines too), so a reaped attempt still running cannot
  replace the images the winning attempt's results point at. Repeated URLs are compared
  once.
- **Images never touch the worker's disk**: current and diff go to
  `runArtifactKey(org, project, <run uuid>, …)` (the uuid is what #460 checks), the
  baseline to `baselineKey()`. Results keep `project`, `newBaseline` and the keys.
- **An HTTP >= 400 page fails the job**, like a11y's `failOnHttpError`: the egress proxy
  answers a refused target with a 403 page, which must not become a baseline.
- **Bounded**: no new page after `JOB_DEADLINE_MS` (10 min; heartbeats keep a slow live
  job from being reaped, #442), 30 s per page load, 5 s for fonts, and a full page taller
  than `MAX_PAGE_HEIGHT` (16384 px) is refused before it is decoded for a diff (#282). A
  page whose size changed is diffed (`layoutChange`, below); a comparison that cannot be
  made stores its `error`. `runWorker`
  alternates which kind it claims first, so neither starves.
- **Without `IRIS_S3_*`** the API answers 503 to visual submits and approvals, and the
  worker claims a11y only; a partial config makes either exit 3.
- **Billed per comparison** (owner decision, 2026-10-05): the `visual_job` usage row's
  quantity is the job's comparisons (pages x devices), so `runsPerMonth` limits screenshots,
  not jobs; enforcement (#346) sums `quantity`. An a11y job is quantity 1.
- No AI classification in hosted visual jobs yet (BYOK/credits wiring is #346).
- `ApiJobs` (src/jobs-api.ts) is the slice of `OrgJobs` the API uses; approval is optional
  in it, so the API tests' in-memory stores (`api-jobs`, `protocol-observability`) need
  no visual support. The root `tsc` does not compile `__tests__/`: after changing a type
  that tests implement, run them with `jest --no-cache` (ts-jest caches diagnostics).

### Results API (issue #269)

`GET /v1/runs` and `GET /v1/runs/:id` on the hosted listener, beside the job routes in
`src/jobs-api.ts`: same key auth, suspension 403, rate buckets, verify cap and request
logging (route labels `GET /v1/runs`, `GET /v1/runs/:id`). `startServer({ runs })`;
hosted `iris connect` passes the same `postgresHistory` it records into.

- **`listPage()`** (src/history-store.ts) is keyset-paged on `(finished_at desc, id desc)`
  (migration 0008's partial index), finished runs only, one row over the page to know
  there is a next one. **Finish time, not creation**: a job is created when queued, and one
  finishing after a client's cursor passed its creation time was never listed. Filters:
  `kind`, `status` (incl. `canceled`), `from` (inclusive), `to` (exclusive) on `finished_at`.
- **The cursor's time is `to_char(… at time zone 'UTC', …US"Z")`**, base64url with the
  id: microseconds (a JS `Date` keeps milliseconds and skipped rows inside one millisecond)
  and independent of the server's DateStyle/TimeZone (`::text` follows them: `SQL, DMY`
  broke every second page). The decoder round-trips the time through `Date`, so
  `2026-99-99` is a 400, not a cast error (500). The org filter applies to every page.
- **Query parameters are a strict zod schema**, each at most once (`Object.fromEntries`
  keeps the last of a repeat), `limit` plain digits (`Number()` reads `0x10`, `1e1`).
- Run detail is the stored run (sanitised when recorded, #254: no typed values, no URL
  userinfo) with `redactString()` (src/log.ts) over every string, so secret-looking query
  values (`?token=`) do not reach every key of the org.
- **Signed artifact URLs (#460)**: a result's `result.artifacts` holds object keys (the
  hosted visual writer, #268, records them with the run's uuid as the key's run id). Run
  detail redacts first, then `signRunArtifacts()` (src/artifact-store.ts) turns each key
  into `{ url, expiresAt }`: only keys under the caller's org that are this run's artifact
  or a baseline of the same org are signed; others are dropped and logged. Signing after
  redaction is required: `redactStrings` would cut `X-Amz-Signature`. Raw keys never
  leave: without a store (`IRIS_S3_ENDPOINT` unset) `artifacts` is omitted.
  `resolveArtifactStore()` reads `IRIS_S3_ENDPOINT` / `_BUCKET` / `_REGION` /
  `_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY(_FILE)`; partial config makes hosted `iris
  connect` exit 3. The variables are on the `jest.setup.ts` scrub list.

### Artifact Store (issue #257)

`src/artifact-store.ts`: `ArtifactStore { put, get, signedUrl }` with
`FilesystemArtifactStore` (local) and `S3ArtifactStore` (hosted), used by visual jobs
(#268), signed run-detail URLs (#460) and purge (#349/#472).

- **SeaweedFS, not MinIO** (owner decision, 2026-10-03): MinIO's community images and
  binaries are gone (pull denied, download 410). The code speaks only the S3 API
  (`@aws-sdk/client-s3` + presigner, path-style), so the production vendor stays open.
- **Keys are tenant-first and built from validated segments**: `runArtifactKey()` →
  `org/<org>/project/<project>/run/<runId>/<kind>/<name>.png` (#343's run id and
  `artifactName`), `baselineKey()` → `org/<org>/project/<project>/baselines/<name>.png`.
  Segments are `[A-Za-z0-9_-]{1,128}`; both stores also refuse any key that is not safe
  segments (no `..`, no leading `/`), so the filesystem store cannot leave its root.
- **The bucket is private because the server has identities.** SeaweedFS with no
  `-s3.config` serves anonymous requests; `docker/seaweedfs-s3.dev.json` defines one
  identity, and the test proves an unsigned GET is a 403 next to a signed one that works.
- **Hosted callers take `orgArtifacts(store, orgId)`, not the store.** The store accepts
  any well-formed key; the org view refuses every key outside `org/<orgId>/` (and
  `org/<orgId>X/`), so a stored or client-influenced key cannot reach another tenant.
- **Signed URLs default to 5 minutes and are capped at 15** (a non-finite TTL is the default). A URL edited to another key
  is refused (the signature covers the path).
- **CI starts SeaweedFS as a step** (`docker run`), not a service container: services
  cannot pass a command line. Image pinned by version and digest in both places.
- **Tests need `IRIS_TEST_S3_ENDPOINT` / `_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY`**:
  required under `CI`, skipped locally when unset (the Postgres pattern). Each run makes and
  removes its own bucket.

### Offboarding and Retention (issue #349)

`src/offboarding.ts`, migration 0010, `iris admin delete-org | restore-org | delete-user |
retention`, `deploy/retention.sh` + `deploy/systemd/iris-retention.*`. Periods are the
owner's decisions (2026-10-03). Ops side: runbook "Retention and offboarding".

- **Deletion is a soft delete**: `org_deletions` (purge_after = request + 30 days) plus a
  suspension, so #348's enforcement stops keys, jobs and portal writes at once.
  `restoreOrg` lifts only the suspension the request added (its exact reason), never an
  operator's abuse suspension, and refuses an org whose only owner was deleted during the
  grace period (same lock as `deleteUser`). Both take #348's suspension lock before reading
  the latest state.
- **The purge keeps a tombstone**: the org row stays ("Deleted organization", slug
  `deleted-<uuid>`: a customer may own `deleted-<id>`; one `system` suspension) so `usage_events` (FK, no cascade) survive 7
  years, detached from runs (`run_id = null`) and with nothing naming the tenant. The
  7-year pass deletes usage, suspensions, the deletion row and the org. One transaction
  per org: a failure is logged and retried by the next pass.
- **Runs after 90 days**: usage rows are detached first, since `usage_events -> runs` has
  no delete rule and would block the delete.
- **Audit entries after 90 days (#541)**, except a live key's creation entry: see "Tenant
  Audit Log" above.
- **Terms evidence is pseudonymised by the database**, not by code: whatever deletes a user
  (BetterAuth, `delete-user`, SQL) fires the trigger. `deleteUser` refuses while the user
  is the only owner (comma roles, as #260) of an org with no pending deletion.
- **AI state is per container**: the cost ledger and vision cache are SQLite under each
  container's `/data`. `purgeOrgAiState(purgedOrgIds, cacheDir)` matches `org_id` and the
  `org=<id>:` key prefix by `substr` (an `_` in an id is no LIKE wildcard). That is why the
  timer runs `retention` in both `iris` and `worker`; the Postgres part is idempotent.
- **Object storage follows the rows (#472)**: `purgeOrg` queues `org/<org>/` and the runs
  step queues each expired visual run's `org/<org>/project/<p>/run/<id>/` in
  `artifact_purges` (migration 0012), in the same transaction that deletes the rows; the
  last step drains it with `ArtifactStore.deletePrefix()` (filesystem rm, S3 list +
  batched delete, paginated) and removes an entry only once its objects are gone. A
  failure is reported (exit 3) and retried next pass. Without `IRIS_S3_*` the queue waits.
  Current baselines stay until the org is purged. A replaced one (#475) is deleted by the
  `baselines` step once it is older than 90 days, not any `visual_baselines.object_key`,
  and no remaining `run_results.result->'artifacts'->>'baseline'`; an org with a visual job
  queued or running is skipped that pass (it may still record a link). The inventory is
  `artifact_objects` (#315), so images stored before it are not found; deletion is
  `ArtifactStore.delete(key)` (S3 `DeleteObject`, filesystem `rm --force`).
  Each candidate is re-checked and deleted with its `artifact_objects` row locked
  (`for update`), and the quota write refreshes that row's `created_at` on a rewrite, so a
  re-approval reusing the key is either seen as new or waits and writes the object again.
  Candidates are taken in random order, so failing ones cannot starve the rest; a failure
  is reported after the others are tried.
  A purged org's `org/<org>/` is queued once more a day after the purge (#476: a visual job
  running at the purge can still write; its finish is refused), marked by
  `org_deletions.resweep_done` (migration 0017). `purged_at` is the pass's `now`, not the
  database clock, so tests cross the day with the injected clock.
- **Not purged**: live orgs' AI ledger rows (no period decided).

### Run History Store (issue #254)

`src/history-store.ts` puts run history behind one seam. `RunInput` is what the
code that ran it has: a `VisualTestResult`, an `AccessibilityTestResult`, or an
`executeBrowserAction` request's `ExecutionResult[]`. Each store maps it to its own
tables.

- **Hosted: `postgresHistory(db).forOrg({ orgId, apiKeyId })` is the only way in**,
  and every query filters by that org. No read path exists without a tenant. `get`
  of another org's run id returns `null`, as does a non-uuid id (checked before
  Postgres rejects the cast). Records are one transaction (run plus its results,
  one multi-row insert). Results are ordered by `run_results.position`: every row
  of the transaction shares `created_at`, and ids are random uuids.
- **`runs.api_key_id` has a same-org FK** (migration 0002): `(org_id, api_key_id)`
  references `apikey ("referenceId", id)`, `on delete set null (api_key_id)`, so a
  run cannot name another org's key, and revoking a key keeps its runs. A key
  revoked between authentication and the write raises `23503`; the store retries
  once without the key, which is where `set null` would have left it anyway.
  `(org_id, api_key_id)` is indexed so a revoke does not scan the org's runs.
- **Hosted RPC records each `executeBrowserAction`** (`startServer({ history })`,
  wired by `hostedServices()` over the auth pool). An action is stored as
  `describeAction()`, which never includes what a `fill` typed, and a navigate URL
  loses its `user:password@`. Errors are cut to 500 characters and lose terminal colour
  codes (`stripAnsi`, src/report-encoding.ts, #420: Playwright colours its call log). The write is awaited
  before the reply, so a reply means the run is recorded (#269 reads it). A failed write is logged, and the request still succeeds. Local
  (token) connections record nothing.
- **Local: `sqliteHistoryStore(path)`** over the #77 tables. `test_results` has no kind
  column, so a run is recognised by the exact summary shape `summarize()` writes
  (`visual: N comparison(s), M failed`, …); rows `iris run` / `iris watch` write are
  not runs of the store, even when a user's instruction starts with `visual: `. It lists by insertion
  order, because SQLite's `created_at` has one-second resolution.
- **Local writes are one transaction, reads by key (#356).** `recordSqliteRun` wraps the run row
  and its result rows in one `db.transaction` (all or nothing, one commit; nested in a
  caller's transaction it is a savepoint). `list` reads `iterateTestRuns` (by id, newest
  first) and stops at `limit` runs; `get` reads by primary key (`getTestRun`) and accepts
  only a canonical integer id. `getTestRuns` breaks `created_at` ties by id.
- **SQLite files are created 0600** by `ensureDatabaseDir` (db.ts) before SQLite opens them,
  for the history, the vision cache and the cost ledger (#356): the data directory may
  already exist with wider permissions than the 0700 it is created with. An existing file
  keeps its mode. Private backlog item P1.24; criteria derived from the code
- Hosted CLI `a11y` / `visual` are not tenant surfaces. Hosted a11y/visual runs arrive
  with the job APIs (#267/#268), which call the same store.
