# Data flows and retention (issue #277)

What the hosted IRIS service stores, where, who can read it, and how long it is kept, and
what it sends to third parties. This is the engineering source of truth behind the portal's
[privacy policy](../apps/portal/content/legal/privacy.md),
[subprocessor list](../apps/portal/content/legal/subprocessors.md) and
[DPA template](legal/dpa-template.md). Every entry cites the code that implements it.

**Keep it current.** A change that adds, removes or changes a data store, a field holding
personal data, a retention period or a transmission to a third party updates this file in
the same pull request, and the privacy policy and subprocessor list when the change is
visible to customers.

Retention periods are the owner's decisions of 2026-10-03 (#349), applied by the daily
retention pass (`iris admin retention`, `src/offboarding.ts`, `deploy/retention.sh`):
deleted orgs are soft-deleted for **30 days**, then purged to a tombstone; their billing
records are kept **7 years**, detached and pseudonymised; finished runs are kept **90 days**;
audit entries are kept **90 days** (decided 2026-11-08, #541);
expired sessions and tokens are purged **daily**; terms-acceptance evidence is kept **7 years**
after the user is deleted, pseudonymised. What is still marked **undecided** has no
configured limit: the data stays until it is deleted by hand.

## Where the hosted service runs

`docker-compose.production.yml`: four containers on one host (the hosting provider is a
subprocessor): `iris-api` (`iris connect`: WebSocket RPC + REST job API), `worker`
(`iris worker`), `portal` (Next.js), `postgres`. Named volumes: `iris-pg` (Postgres data),
`iris-data` and `worker-data` (`IRIS_DATA_DIR=/data`). Public traffic arrives over TLS
through the host's nginx (`deploy/nginx/iris.conf`, #347). Postgres publishes no port.

## Data stores

### Accounts and sessions (BetterAuth tables)

| | |
|---|---|
| Data | `user`: name, email, email-verified flag, optional image. `account`: password hash (BetterAuth's scrypt), OAuth columns unused (no social providers). `session`: token, expiry, **IP address and user agent** of the browser that signed in, active org. `verification`: email-verification and password-reset tokens. |
| Purpose | Sign-up, sign-in, email verification, password reset (#249). |
| Where | Postgres, migration `src/db/migrations/0001_initial.ts`; config in `src/auth/config.ts`. |
| Access | The user (portal). Operators with database access. |
| Encryption | TLS in transit. Passwords hashed. No application-level encryption at rest; disk encryption depends on the hosting provider. |
| Retention | Session: BetterAuth's defaults, as `createAuth()` sets no `session` options: expires 7 days after it was last extended (use extends it at most once a day); all sessions are revoked on password reset. Reset token: 1 hour (BetterAuth default). Expired session and verification rows are purged by the daily retention pass. User and account rows: until the user is deleted (`iris admin delete-user`, on request; refused while the user is a live org's only owner). |

Sign-in rate limits are counted per client IP in the portal process's memory (BetterAuth
`rateLimit`, `src/auth/config.ts`); lost on restart, never written to disk.

### Organizations, members and invitations

| | |
|---|---|
| Data | `organization` (name, slug), `member` (user, org, role), `invitation` (invitee **email**, role, inviter, status, expiry), `user_active_orgs` (the org each user last made active, #409). |
| Purpose | Tenancy: the org is the tenant (#250, ADR 0001 §4). |
| Where | Postgres, `0001_initial.ts`, `0019_user_active_orgs.ts`; plugin options in `src/auth/config.ts`. |
| Access | Members of the org (roles owner/admin/member). Operators. |
| Encryption | As above. |
| Retention | Invitation: expires after 48 hours (BetterAuth default, not overridden); the row stays. Tenants cannot delete an org themselves (`disableOrganizationDeletion`); the operator does it on request (`iris admin delete-org`): suspended at once, restorable for **30 days** (`restore-org`), then purged. Members, invitations, keys, provider keys, plans, the AI setting (`org_ai_settings`, which names the user who set it), who last had it active (`user_active_orgs`) and runs are deleted; the org row stays as a tombstone (name "Deleted organization", a random `deleted-<uuid>` slug) holding only its billing records, for 7 years. |

### API keys

| | |
|---|---|
| Data | `apikey`: SHA-256 hash of the key (never the plaintext), first 11 characters (`start`), name, owning org (`referenceId`), enabled flag, `lastRequest`, counters. |
| Purpose | Authenticating the RPC and REST APIs as an org (#340, #341). |
| Where | Postgres, `0001_initial.ts`; `@better-auth/api-key` with `references: 'organization'` in `src/auth/config.ts`; verification in `src/api-key-auth.ts`. |
| Access | Org members can list (owners/admins create and revoke). The plaintext is shown once, at creation. |
| Encryption | Hashed at rest. |
| Retention | Revoke deletes the row at once. Otherwise until revoked or the org is purged (30 days after its deletion is requested). |

### AI provider keys (BYOK)

| | |
|---|---|
| Data | `provider_keys`: an org's OpenAI or Anthropic API key, provider, timestamps. |
| Purpose | Making AI calls for that org on its own vendor account (#344, #258). |
| Where | Postgres, `0001_initial.ts`; `src/byok/store.ts`, `src/byok/crypto.ts`. |
| Access | Owners/admins set and remove; members see only which providers are set. The plaintext leaves the store only through `credentialsFor()`, for the server to make that org's calls. Never shown back, never logged. |
| Encryption | Envelope encryption: a fresh AES-256-GCM data key per stored key, wrapped by a master key from `IRIS_KEY_ENCRYPTION_KEY(_FILE)`; both layers bind key id, org and provider as AAD. |
| Retention | Until the org removes it (deleted at once), or the org is purged (30 days after its deletion is requested). |

### Run history and job queue

| | |
|---|---|
| Data | `runs`: kind (`a11y`, `visual`, `rpc`), status, timestamps, the API key that started it, a summary, `params` (a11y jobs: target **URLs**, WCAG level, fail-on levels), a bounded error message. `run_results`: per page or action, the URL, pass/fail and a result object. a11y stores violation **counts** per impact, keyboard/screen-reader pass flags, a score, a needs-review count with up to 20 axe rule ids (#498), and which rules were violated (`violationRules`: axe rule id, impact and element count, at most 50 per page, #314), and for a page that redirected, by HTTP or by itself before the scan (#662), where the scan landed (`landedUrl`: origin and path only, a path segment of 32 or more characters replaced by `…`, at most 200 characters, never the query string or fragment, #648; only for pages given as absolute URLs), not axe's HTML snippets, selectors or page text. A hosted MCP tool call (`POST /v1/mcp`, #314) is stored as the a11y job it queues: the same rows, nothing more. An RPC action is stored as `describeAction()` (never what a `fill` typed); a navigate URL loses its `user:password@`; errors are cut to 500 characters. |
| Purpose | The queue for `iris worker` (#267, #435) and the org's run history (#254). |
| Where | Postgres, migrations `0001`, `0002`, `0004`, `0005`; `src/history-store.ts`, `src/jobs-api.ts`, `src/worker.ts`. |
| Access | Everyone in the org (that is why credentials in URLs are refused with a 400 and typed values are never stored). Operators. |
| Encryption | As above. |
| Retention | **90 days** after the run finished (the daily retention pass); queued and running jobs are never pruned. A deleted org's runs go when it is purged. The run's billing records stay (their `run_id` is cleared). |

The worker writes no report or screenshot file (`src/worker.ts`: no `output`); page content
is processed in Chromium's memory for the duration of the job.

### Usage events (billing record)

| | |
|---|---|
| Data | `usage_events`: org, run, kind (`browser_minutes`, `text_call`, `vision_call`, `agent_turn`, `a11y_job`, `visual_job`, `observation`), quantity, unit cost, billing mode, estimated flag, idempotency key, and when a managed row was sent to the Stripe meter (`stripe_reported_at`, #264). No content. |
| Purpose | Metering and billing (#263). |
| Where | Postgres, `0001`, `0003`, `0021`; `src/billing/usage.ts`, `src/billing/stripe-meter.ts`. |
| Access | Operators; the org's own usage view (#271, pending). |
| Retention | While the org exists, and **7 years** after it is purged, on a tombstone org with no name, members or keys (pseudonymised); then deleted. The 7 years is the owner's decision pending counsel's confirmation for the jurisdiction (#450). |

### Org plans

| | |
|---|---|
| Data | `org_plans`: org, plan id (`free`/`pro`/`team`), per-org overrides of plan limits, last update. No personal data. An org with no row is on free. |
| Purpose | Entitlements (#260): which limits apply to the org, enforced at the API (#346). |
| Where | Postgres, `0009`; `src/billing/plans.ts`. |
| Access | Operators; the verified Stripe webhook sets the plan from the current subscription's price as read from Stripe (#345), only when it changes, so a support grant survives other events. Shown on `/org` (#261). |
| Retention | Deleted when the org is purged. |

### Org billing (Stripe)

| | |
|---|---|
| Data | `org_billing`: org, Stripe customer id, the current subscription's id and status as last read from Stripe, last update. `stripe_events`: Stripe event id, org, event type, time processed. No card data (it stays at Stripe) and no personal data. |
| Purpose | One Stripe customer per org, and the subscription state taken only from signature-verified webhooks (#261, #345); `stripe_events` makes each event apply once. |
| Where | Postgres, `0020_org_billing.ts`; `src/billing/stripe.ts`, `src/billing/stripe-webhook.ts`. |
| Access | Operators; the org's members see the plan and status on `/org`, owners and admins open Checkout and the Customer Portal. |
| Retention | Kept on the purged org's tombstone as a billing record, and deleted with it after **7 years** (cascade). |

### Terms acceptances

| | |
|---|---|
| Data | `terms_acceptances`: user, document (`terms`, `acceptable-use`), version, time, and the **client IP** at acceptance. |
| Purpose | Evidence of which version of the Terms and AUP each person accepted (#276). |
| Where | Postgres, `0006_terms_acceptances.ts`; `src/legal/acceptance.ts`. |
| Access | Operators. |
| Retention | While the user exists. When the user is deleted, a database trigger (migration 0010) replaces `user_id` with a SHA-256 of it (`user_hash`, `pseudonymised_at`): the document, version, time and IP are kept **7 years** for disputes, then deleted. |

### User bans

| | |
|---|---|
| Data | `user_suspensions`: user, action (`suspend` / `unsuspend`), the operator's **reason** and actor name, time. |
| Purpose | Operator account bans (#457): a banned user cannot sign in. |
| Where | Postgres, `0016_user_suspensions.ts`; `src/org-suspension.ts`. |
| Access | Operators (`iris admin ban-user | unban-user | user-status`). Never shown to the user. |
| Retention | While the user exists; deleted with the user (cascade). |

### Audit log

| | |
|---|---|
| Data | `audit_log`: org, `actor_user_id`, `actor_api_key_id` (plain ids, no foreign keys, so an entry outlives its actor), action, target, `metadata jsonb`, time. |
| Purpose | An org's audit trail (#361). |
| Where | Postgres, `0001_initial.ts`. |
| Status | Recorded (`src/audit-log.ts`, each in the transaction that makes the change): API key create, update (field names only) and delete with the acting user (`api_key.*`, BetterAuth hooks in `src/auth/config.ts`); provider key save (`replaced` true/false), remove and operator rewrap (`provider_key.*`: the provider and master key id, **never the key**); AI mode (`ai_mode.set`); plan and overrides (`plan.set`); job submit with the API key (`job.submit`, `run:<id>`), and the withdrawal of a still-queued job whose MCP caller disconnected (`job.cancel`, #314: the `runs` row is deleted, the two audit entries remain); member removed, left or given a role (`member.remove|leave|role`, the member's user id, and the keys revoked with them); keys revoked by a user ban (`api_key.delete`, reason `user banned`, no actor); RPC session start and end with the API key (`session.*`); visual baseline approval (`visual_baseline.approve`, #463); Stripe customer created for the org, with the acting user (`billing_customer.create`, `customer:<id>`, #261); each applied Stripe event (`subscription.update`, `event:<id>`, its type and the subscription id, status and plan read from Stripe, no actor, #345). No URL, page content or typed value is recorded. |
| Access | The org's owners and admins on the portal's `/audit` page (#541), newest first, with the acting user's name and email while they exist; members are refused. Operators by query. |
| Retention | **90 days** (owner decision 2026-11-08, #541): the daily retention pass deletes older entries. One exception: the `api_key.create` entry of a key that still exists is kept until the key is revoked, because it is the only record of who made the key and a member's removal, leave or ban revokes their keys by it (#408, #457); it goes on the first pass after the key does, or after its creator's account is deleted (the entry then names nobody). Also deleted when the org is purged; a deleted user's id is removed from their entries (#349). The portal's `/audit` page states the period. |

### Artifact storage usage

| | |
|---|---|
| Data | `artifact_objects`: org, object key, size in bytes, time. No content. |
| Purpose | Enforce and show each plan's artifact storage (#315). |
| Where | Postgres, migration 0015 (`src/storage-quota.ts`). |
| Access | The worker, the API and the portal (usage on the dashboard). |
| Retention | Removed with the objects: by the retention purge of expired runs and of deleted orgs (#349, #472). |

### AI cost ledger

| | |
|---|---|
| Data | `cost_tracking` (SQLite): time, provider, model, operation, cost (USD, and exact integer micro-dollars since #318), token counts, pending/estimated flags, org id, run id. No prompt or response content. |
| Purpose | Budget circuit breaker and reservations before each AI call (#242, #244, #255). |
| Where | `<IRIS_DATA_DIR>/cache/cost-tracking.db` (`src/ai-client/factory.ts`, `src/ai-client/smart-client.ts`, `src/ai-client/cost-tracker.ts`); in production the `iris-data` / `worker-data` volumes. |
| Access | Operators. |
| Retention | A purged org's rows are deleted by the daily retention pass in each container. Live orgs' rows: no pruning, **undecided**. Not included in backups. |

### AI vision cache

| | |
|---|---|
| Data | `ai_vision_cache` (SQLite) and an in-memory LRU: the model's verdict JSON (severity, reasoning, categories, suggestions), keyed by provider, model, image hashes and the org. Not the images. The reasoning can quote what was on the page. |
| Purpose | Not paying twice for the same comparison (#124, #255). |
| Where | `<IRIS_DATA_DIR>/cache/vision-cache.db` (`src/ai-client/smart-client.ts`, `src/ai-client/cache.ts`). |
| Access | Operators. Keys carry the org, so one org's verdict is never served to another. |
| Retention | **30 days** (`ttlMs: 30 * 24 * 60 * 60 * 1000`, `src/ai-client/cache.ts`); expired rows are pruned on a throttle. Hosted vision is not live yet (visual jobs, #268). |

### Screenshots and visual artifacts

The local CLI writes screenshots, diffs and baselines under `<artifactsDir>/runs/<runId>/`
and `.iris/baselines` on the user's own machine (`src/visual/artifacts.ts`, #343). Each run
keeps the newest 20 run directories and deletes older ones when it ends (`--keep-runs`, #425);
baselines are not pruned by it.

The RPC `observe` method (#312) sends a viewport screenshot and an ARIA snapshot of the
session's page to the connected client and stores neither; fields filled from a credential
reference are masked in the screenshot and cut from the snapshot.

The hosted service stores them for visual jobs (#268, `src/visual/hosted-job.ts`) in a
private S3-compatible bucket (`src/artifact-store.ts`, #257):

| | |
|---|---|
| Data | Full-page PNG screenshots of the pages a tenant tests (they may show anything those pages show), red-on-transparent diff images, and each project's approved baseline per page and device. `visual_baselines` (Postgres, migration 0011) records the project, page URL, device, object key, source run and approving key id. |
| Purpose | Visual regression testing: comparing a page with its approved look. |
| Where | Bucket keys `org/<org>/project/<project>/run/<run uuid>/{current,diff}/<name>.png` and `org/<org>/project/<project>/baselines/<name>.png`. |
| Access | The org's API keys, through run detail's signed URLs (5 minutes, at most 15; only that org's keys for that run, #460). The bucket is never public. |
| Retention | Run images: with the run, **90 days** after it finishes; current baselines: until the org is purged; a replaced baseline image, once no remaining run links it and it is older than 90 days (#475; images stored before #315's accounting stay until the org is purged). The daily retention pass queues each prefix (`artifact_purges`, migration 0012) in the transaction that deletes its rows and deletes the objects when the container has `IRIS_S3_*`; a store failure is retried by the next pass (#472). A purged org's prefix is swept once more a day after the purge, for images a job already running at the purge wrote afterwards (#476). |
| Third parties | The hosting / object-storage provider (#273). Not sent to an AI vendor: hosted visual jobs run no AI analysis yet. |

### Browser sessions

A hosted RPC session's Chromium context (cookies, storage, page content) lives in memory and
on the container's tmpfs. It ends when the client closes it, the connection drops, or after
30 minutes idle (`sessionTimeout`, `src/protocol.ts`). Downloads and service workers are
blocked (`src/browser.ts`).

**Credential values** (#352): a fill may name `{{secret:NAME}}`; on the RPC the value
comes in that request's `secrets` (never the server's environment) and is typed at fill
time (`src/credential-refs.ts`, `src/executor.ts`). It is not stored or logged; the session
holds it in memory, like the page that holds it, until the session ends. The reference,
not the value, is what results and history carry, and a failed fill's error has the value
cut.

### Logs

| | |
|---|---|
| Data | JSON lines on stderr (`src/log.ts`): event, org id, API key id, session/job ids, method, outcome, timings, error messages. Never keys, passwords, typed values, instructions, request bodies or job params: `redact()` also strips URL userinfo, `Bearer`/`Basic` credentials, secret-looking query parameters and `iris_` keys from strings. IRIS's own lines carry no client IP. |
| Where | Docker's `json-file` driver per container. The host nginx access log (operator-configured) records client IPs and request lines. |
| Access | Operators. |
| Retention | Rotated at **10 MB × 3 files per container** (`docker-compose.production.yml`, `logging.options`); older lines are overwritten. nginx access logs follow the host's log rotation (operator-configured). |

Metrics (`src/metrics.ts`) carry no org id and are reachable only from loopback inside the
container.

### Backups

| | |
|---|---|
| Data | A `pg_dump` of the whole database (everything above that lives in Postgres) and the BYOK master key file. Not the SQLite ledger or cache. |
| Where | `/var/backups/iris` on the host; optionally copied off the box with rclone to `BACKUP_RCLONE_REMOTE` (`deploy/backup.sh`, #274). |
| Encryption | Encrypted with `age` to public keys before being written; the decryption identity stays off the box. The script refuses to write plaintext. |
| Retention | On the host: the newest `BACKUP_KEEP_MIN` (default **7**) of each kind are always kept; the rest are deleted once older than `BACKUP_KEEP_DAYS` (default **14**). The off-box copy is `rclone copy`, which deletes nothing: its retention is the remote's own policy, **undecided (#349, #445)**. A deleted record therefore survives in backups until they age out. |

## Transmissions to third parties

### AI vendors (OpenAI, Anthropic)

The hosted service calls only OpenAI and Anthropic, and only with the org's own key
(`provider_keys`, **BYOK**): the request is made on the customer's vendor account, under the
customer's agreement with that vendor. Without a stored key the org gets pattern translation
only and nothing is sent (`translate()` treats missing credentials as `null` under
`IRIS_HOSTED`, `src/translator.ts`). Injected credentials refuse `ollama` and any custom
endpoint (`src/ai-client/credentials.ts`), so Ollama is local-mode only. No other vendor is
contacted unless the org opts into fallback, and with BYOK only the org's vendor has a key.

- **Text translation** (hosted RPC `executeBrowserAction` with an `instruction`, and only
  when pattern matching does not understand it): the instruction text and the request's
  `url`, inside IRIS's fixed system prompt (`src/translator.ts`, `src/ai-client/text.ts`).
  No screenshot and no page content. A literal fill value in the instruction is sent with
  it; a `{{secret:NAME}}` reference is sent as the reference, never its value (#352).
- **Vision classification** (local CLI today; hosted with #268): the baseline and current
  screenshots, optionally the pixel-diff mask, the page URL and element selector, and up to
  three previous classifications (`src/ai-client/vision.ts`).
- **Agent loop** (local CLI `--agent` only, not hosted): each turn also sends the page URL,
  title and an accessibility snapshot of the page text, capped at 4,000 characters
  (`src/agent-loop.ts`). The snapshot includes what fields hold; values typed from a
  credential reference are cut from it (#352).

**Managed credits** (#479): an org whose owners choose IRIS credits (`org_ai_settings.mode
= managed`) sends the same data on IRIS's own vendor key (`IRIS_MANAGED_AI_PROVIDER` /
`IRIS_MANAGED_AI_KEY`, operator configuration) until its plan's monthly credit is spent,
then on its own key if it has one (`src/billing/managed-ai.ts`). For those requests the
vendor is IRIS's subprocessor. The ledger row carries `billing_mode = managed`. Each
vendor's own retention applies to what it receives. While a managed call is in flight, a
`managed_ai_reservations` row (org, worst-case amount, time; no content) holds its credit
(#482); it is deleted when the call ends, or after 10 minutes, and with the org. A call that was billed but whose usage row could not be written keeps its row (`held`) until the month ends.

### Email (SMTP provider)

The portal sends verification, password-reset and invitation emails through the SMTP server
in `SMTP_URL(_FILE)` (`apps/portal/lib/mail.ts`, `src/auth/config.ts`). Sent: the recipient
address, and the link with its token; an invitation also carries the inviter's name and the
org name. The provider is a subprocessor; its retention applies.

### Payments (Stripe)

Live when the operator sets `IRIS_STRIPE_*` (#261, #345); off otherwise. IRIS sends Stripe
the org id (customer metadata `org_id`, and `client_reference_id` on Checkout) and the
price of the plan chosen (`src/billing/stripe.ts`). The customer enters billing contact
and card details on Stripe's own Checkout and Customer Portal pages: IRIS never receives or
stores them. Stripe sends IRIS signed webhook events (`POST /v1/stripe/webhook`). For each new one about a
known customer, `iris connect` calls the Stripe API once (list that customer's
subscriptions, sending the customer id) and keeps the current subscription's id and status,
and the event id (Org billing, above); the event's own payload is not stored or applied.
The worker also reports managed AI usage to a Stripe meter (#264,
`src/billing/stripe-meter.ts`): per `managed` usage row, the org's Stripe customer id, the
row's provider cost in micro-USD, its time, and an identifier made from the row's id
(`usage-<uuid>`). No kind, model, run or content is sent, and BYOK and platform usage never
are. `iris admin billing-reconcile` reads the meter's totals per customer back.
Stripe is a subprocessor; its retention applies.

### Off-box backup storage

Only when `BACKUP_RCLONE_REMOTE` is set: the age-encrypted backups above. The storage
provider cannot read them.

### Sites under test

IRIS's browser requests the URLs the customer names, from the hosting provider's network,
through the egress proxy that refuses private addresses (`src/egress-proxy.ts`). Those sites
are chosen by the customer and are not IRIS's subprocessors.
