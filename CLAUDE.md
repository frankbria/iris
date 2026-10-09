# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

IRIS (Interface Recognition & Interaction Suite) is an AI-powered UI understanding and testing toolkit under active development. The project gives AI coding assistants "eyes and hands" to see and interact with user interfaces through natural language commands.

## Development Commands

```bash
# Build the TypeScript source
npm run build

# Run tests
npm run test

# Quality gates (also enforced in CI)
npm run typecheck      # tsc --noEmit
npm run lint           # eslint (flat config, eslint.config.js)
npm run format:check   # prettier --check (blocks CI: run prettier --write first)
npm run verify         # typecheck + lint + test in one step

# Start development server (ts-node)
npm start

# Run CLI commands during development
npm start run "natural language instruction"
npm start watch [target]
npm start connect

# Portal workspace (apps/portal, #247) — run from the repo root
npm run dev   -w @iris/portal
npm test      -w @iris/portal
npm run lint  -w @iris/portal
npm run build -w @iris/portal   # next build also type-checks
```

## Architecture

### Project Structure

```
src/
├── cli.ts                  # CLI interface and command routing
├── browser.ts              # Browser automation wrapper
├── ai-client.ts            # Backward compatibility layer (re-exports)
├── ai-client/              # AI client modules (Phase 2)
│   ├── base.ts            # Abstract base classes for text + vision
│   ├── text.ts            # Text-based AI clients (Phase 1)
│   ├── vision.ts          # Vision AI clients (GPT-4o, Claude Sonnet 5, Ollama)
│   ├── preprocessor.ts    # Image preprocessing pipeline
│   ├── cache.ts           # LRU + SQLite caching system
│   ├── cost-tracker.ts    # Budget management and cost tracking
│   ├── smart-client.ts    # Smart client with fallback logic
│   ├── factory.ts         # Client factory with provider detection
│   ├── models.ts          # Model pins + live provider model-list probe
│   └── index.ts           # Module exports
├── visual/                # Visual testing modules
│   ├── hosted-job.ts      # runVisualJob: hosted visual-diff job against project baselines, images to object storage (#268)
│   ├── capture.ts         # Screenshot capture with stabilization
│   ├── diff.ts            # SSIM + pixel diff engine
│   └── baseline.ts        # Git-integrated baseline management
├── mcp/                   # MCP stdio server (experimental, spike scope)
│   ├── server.ts          # `iris-mcp` bin — McpServer over StdioServerTransport
│   └── tools.ts           # run_accessibility_test (axe violations + needsReview)
├── auth/config.ts         # createAuth(): the BetterAuth config portal + API share (ADR 0001 §4, #247)
├── legal/                 # versions.ts: current ToS/AUP versions + ACCEPTED_TERMS; acceptance.ts: record/check (#276)
├── api-key-auth.ts        # Hosted `iris connect`: Bearer org API key -> { orgId, keyId } (#341)
├── db/                    # Hosted Postgres (ADR 0001 §2, #248)
│   ├── postgres.ts        # resolveDatabaseUrl() (DATABASE_URL / _FILE), createPostgresDb(): Kysely over pg
│   ├── migrate.ts         # migrateToLatest(); `node dist/db/migrate.js` is the deploy step; no-op on a newer schema (#273)
│   └── migrations/        # NNNN_<what>.ts, registered in migrate.ts's MIGRATIONS map (0002: run history, #254; 0003: usage, #263; 0006: terms acceptances, #276; 0007: org suspensions, #348; 0009: org plans, #260; 0010: offboarding, #349; 0011: visual baselines, #268; 0012: artifact purges, #472)
├── agent-policy.ts        # What may the agent DO? (allowlist, origin pin, destructive)
├── url-policy.ts          # Is this single URL allowed? (SSRF / scheme gate)
├── hosted.ts              # IRIS_HOSTED switch: read once, fails closed (ADR 0001 §5)
├── log.ts                 # log(): JSON lines hosted, `[iris] …` locally; redaction net (#275)
├── metrics.ts             # Prometheus registry + serveMetrics(): loopback-only listener (#275)
├── secret-env.ts          # readSecretEnv(NAME): NAME or NAME_FILE, the one `_FILE` reader (#273)
├── url-policy-guard.ts    # Makes that stick per-request (CDP Fetch): redirect hops, sub-resources, popups (#337)
├── egress-proxy.ts        # Hosted: resolve-and-pin HTTP/CONNECT proxy under all Chromium traffic (#336)
├── report-encoding.ts     # One encoder per report format: HTML, XML (JUnit), Markdown, safe hrefs (#339)
├── history.ts             # Records visual/a11y runs to the SQLite history (command layer, not the runners)
├── jobs-api.ts            # Hosted REST on the RPC listener: jobs (#267), runs + run detail (#269)
├── worker.ts              # `iris worker`: claims queued a11y and visual jobs, runs them hardened, stores the result (#267, #268)
├── billing/plans.ts       # Plan catalog (free/pro/team), resolveEntitlements, orgEntitlements(db), one-free-org cap (#260)
├── offboarding.ts         # Org soft delete/restore/purge to tombstone, user deletion, daily retention, AI-state purge (#349)
├── org-suspension.ts      # Operator suspension of an org: history table, state, suspendedSql (#348)
├── artifact-store.ts      # ArtifactStore: filesystem (local) + S3 (hosted, SeaweedFS in dev/CI/staging); tenant-first keys, signed URLs (#257)
├── visual-baselines.ts    # Project baselines (orgBaselines) and audited approval, no runner imports: API + portal (#268, #463)
├── run-reads.ts           # Read-only run queries (types, keyset cursor, listPage, get): no runner imports, so the portal can use it (#270)
├── history-store.ts       # HistoryStore seam: sqliteHistoryStore (local), postgresHistory(db).forOrg() (hosted, #254)
└── config.ts              # Configuration types and validation

__tests__/
├── cli.test.ts                    # CLI command testing
├── browser.test.ts                # Browser automation testing
├── ai-client.test.ts              # Text AI client tests
├── ai-client-vision.test.ts       # Vision AI client tests (17 tests)
├── ai-client-preprocessor.test.ts # Preprocessor tests (24 tests)
├── ai-client-batch4.test.ts       # Cache + cost tracker tests (19 tests)
├── ai-client-models.test.ts       # Model pins, provider probe, resolution (26 tests)
├── ai-credentials.test.ts         # Injected AI credentials: own key per request, no process keys, no other vendor (#258)
├── ai-tenant-scope.test.ts        # Ledger and vision cache per org: breakers, reservations, run-scoped stats, cache isolation (#255)
├── browser-hardening.test.ts      # One launch factory: spawned argv has no --no-sandbox; context hardening; src/ guard (#331)
├── egress-proxy.test.ts           # Proxy over real sockets: resolved-address refusals, rebinding pin, positive controls (#336)
├── egress-proxy-browser.test.ts   # Hosted Chromium: worker/SharedWorker/WebSocket egress and WebRTC UDP (#336)
├── protocol-limits.test.ts        # RPC limits over real sockets: payload, connections, sessions, actions, clamps, heartbeat (#338)
├── session-lifecycle.test.ts      # Real Chromium, counted in /proc: launch-time disconnect, crash relaunch, busy sweep (#240)
├── container-config.test.ts       # Compose hardening, seccomp profile, token file + healthcheck (#332)
├── report-encoding.test.ts         # Every report format parsed for real (DOMParser, markdown-it): hostile input keeps the structure (#339)
├── auth-config.test.ts            # Spawned Node loads src/auth/config via require(esm); Jest's sandbox can't (#247)
├── auth-org.test.ts               # Real Postgres: personal org on sign-in, invitations, roles, org A cannot read org B (#250)
├── auth-apikey.test.ts            # Real Postgres: org-owned keys hashed, roles, org A cannot touch org B's keys, verify, revoke (#340)
├── artifact-store-config.test.ts  # resolveArtifactStore: unset is null, partial refused, secret via _FILE (#460)
├── artifact-store.test.ts         # Keys, filesystem store, S3 store on real SeaweedFS: unsigned/tampered/expired 403, 15 min cap (#257)
├── api-runs.test.ts               # Results API over real sockets + Postgres: list, filters, cursors, detail, 404 cross-org (#269); signed artifact URLs on SeaweedFS (#460)
├── api-jobs.test.ts               # Job REST over real sockets: 401/503/400/413/404/405/429, org isolation, WS upgrade intact (#267)
├── hosted-visual-job.test.ts      # Real Postgres + SeaweedFS + Chromium: first run baselines, second diffs, approve, project scoping, 403 page (#268)
├── hosted-a11y-job.test.ts        # Real Postgres + Chromium, IRIS_HOSTED=1: HTTP submit -> worker -> HTTP result, usage row, refusals (#267)
├── worker-cli.test.ts             # `iris worker` refuses outside hosted mode (exit 2) / without a database (3) (#267)
├── db/jobs.test.ts                # Real Postgres: enqueue/claim (SKIP LOCKED)/finish in one tx/fail, org isolation (#267)
├── protocol-auth.test.ts          # RPC upgrade auth seam: 401/503, pending upgrades vs cap, org-scoped status, revocation re-check (#341)
├── api-key-auth.test.ts           # Real Postgres + spawned hosted `iris connect`: real keys, revoked/disabled 401, startup refusals (#341)
├── db/postgres.test.ts            # Real Postgres: migrate, idempotency, org_id catalog check, BetterAuth round trip (#248)
├── db/offboarding.test.ts         # Real Postgres: soft delete + restore, purge to tombstone, 90-day runs, sessions, 7-year records (#349)
├── offboarding-ai-state.test.ts   # SQLite ledger + vision cache rows of purged orgs removed, others kept (#349)
├── retention-script.test.ts       # deploy/retention.sh vs Docker: runs in iris + worker, alerts on failure/missing (#349)
├── db/entitlements.test.ts        # Real Postgres: no row is free, setPlan + overrides, per org, unknown plan reads as free (#260)
├── billing/plans.test.ts          # Catalog values and override resolution: only known keys and valid values (#260)
├── db/history-store.test.ts       # Real Postgres: runs per org, cross-org list/get empty, same-org key FK, no typed values (#254)
├── ingress.test.ts                # Real nginx (Docker) over deploy/nginx/iris.conf: routing, header overwrite, WSS, 429, headers, TLS (#347)
├── auth-client-ip.test.ts         # Real Postgres: BetterAuth rate limits key on X-Real-IP, not a rotated X-Forwarded-For (#347)
├── repo-hygiene.test.ts           # Public repo: no operator IPs/hosts/home paths; no raw tailscale output in workflows (#329)
├── observability.test.ts          # Logger redaction/levels, exposition format, loopback refusal, spawned --metrics-port (#275)
├── protocol-observability.test.ts # Request logs (RPC + REST, X-Request-Id), no fill value or key in logs, metrics content (#275)
├── auth-logger.test.ts            # Spawned Node: BetterAuth key refusals logged at info, backend failures at error (#275)
├── watchdog-script.test.ts        # deploy/watchdog.sh vs Docker: unhealthy restart + cap, Docker restarts, scrape, error rate (#275)
├── deploy-script.test.ts          # deploy/deploy.sh on local Docker + a throwaway registry: gates, rollback, rerun (#273)
├── backup-script.test.ts          # backup.sh/restore.sh on real Postgres + age: encrypted, restore matches, retention, failure (#274)
├── portal-image.test.ts           # Built portal image (IRIS_TEST_PORTAL_IMAGE): SMTP check, /login, sign-up via _FILE secrets (#273)
├── visual/                        # Visual testing tests
│   ├── capture.test.ts
│   ├── diff.test.ts
│   └── baseline.test.ts
└── mcp/
    └── server.test.ts             # Protocol-level: spawns the built server over real stdio

apps/
└── portal/                        # @iris/portal: Next.js + shadcn Nova, own jest/eslint (#247)

migrations/
├── 001_initial_schema.sql         # Phase 1 database schema
└── 002_ai_cache_cost.sql          # AI cache + cost tracking tables

docs/                               # Detailed project documentation
├── prd.md                         # Product Requirements Document
├── tech_specs.md                  # Technical specifications
├── dev_plan.md                    # Development roadmap
├── user_stories.md                # User stories and acceptance criteria
├── phase2_technical_architecture.md # Phase 2 technical details
├── phase2c_roadmap.md             # Phase 2C roadmap (ROADMAP — not started)
├── integration-surfaces.md        # Which integration surfaces exist and why (decision record)
├── data-flows.md                  # What is stored where, retention, third-party transmissions (#277)
├── legal/dpa-template.md          # DPA template; copy of the portal's /dpa page (#277)
├── adr/0001-hosted-architecture.md # Hosted SaaS architecture — anchors every Cycle 4 platform issue
├── runbook-production.md          # Production setup, promote, rollback (#273); backups, restore, drill log (#274)
└── archive/                       # Superseded planning docs (historical)

deploy/
├── deploy.sh                      # On-box deploy by digest: SMTP + migration gates, rollback (#273)
├── backup.sh                      # Daily age-encrypted pg_dump + master key, retention, rclone copy (#274)
├── restore.sh                     # Decrypt + pg_restore in a disposable pinned postgres container (#274)
├── retention.sh                   # Daily `iris admin retention` in the iris + worker containers (#349)
├── systemd/iris-backup*.{service,timer} # Daily schedule + failure alert, installed by the operator (#274)
└── nginx/iris.conf                # TLS ingress site template for the host's nginx (#347)

plans/
└── README.md                      # Single source of truth: current status / what's next
```

## Development Guidelines

### AI Client Architecture (Phase 2A)

**Multimodal Design:**
- `BaseAIClient`: Abstract class for text-based instruction translation
- `BaseAIVisionClient`: Abstract class extending BaseAIClient with vision capabilities
- Provider implementations: OpenAI (text + vision), Anthropic (text + vision), Ollama (text + vision)
- Factory pattern with automatic provider detection and capability checking

**Key Components:**
- **ImagePreprocessor**: Resizes images to API limits (2048x2048), optimizes quality (85% JPEG), calculates SHA-256 hashes
- **AIVisionCache**: Two-tier caching (LRU memory + SQLite), tracks hit rates, automatic TTL expiration. Key identity = provider + model + baseline hash + current hash + optional diff hash + optional context, so a diff-aware verdict is never served for a diff-less request (issue #124)
- **CostTracker**: Real-time cost calculation, budget enforcement with circuit breaker (blocks paid operations only — cache hits and free providers like Ollama always proceed, issue #68), alert thresholds (80%/95%/100%)
- **Text and agent turns are metered too (issue #242).** `createResolvedAIClient(config, { operation })` returns a `MeteredTextClient` (src/ai-client/factory.ts), the one place every text call is built (translator → `iris run`/RPC/watcher; agent loop with `agent_turn`). It reserves budget *before* the provider call and settles the reservation with the reply's `usage`, on the same ledger as vision, so one budget covers all AI spend. It opens a tracker per call and closes it afterwards, because the RPC server is long-lived; for that reason the unpriced-model "warn once" set is module-level, not per instance. Text clients return `usage` on every reply the provider sent, including ones IRIS then rejects. A reply with no usage (the request failed before the provider billed) writes no row. The deprecated sync `createAIClient()` is still unmetered
- **Budget is reserved before a call and settled after it (issue #244).** `CostTracker.reserve()` checks the breaker and inserts a `pending = 1` row at the call's worst-case cost (8k in / 1k out tokens at the model's rate; text calls add one token per request character, since the instruction is uncapped short of the RPC payload limit) in one `BEGIN IMMEDIATE` transaction, so calls in flight count against the budget, across connections and processes. `settle(id, usage)` rewrites the row with the real cost; `release(id)` deletes it when no reply came back. Admission is "spend + reservations < limit", so N parallel calls end within the limit plus one call. `trackOperation()` never throws: a call that was answered is paid for, and dropping its row is how spend went missing. A pending row left by a crashed process keeps counting at its estimate (fails safe)
  - A reply the provider billed but IRIS rejected (empty, not JSON, outside the schema) throws `AIResponseRejectedError` carrying `usage`, and the smart client settles it before moving on. After a call is settled nothing may send it to the next vendor: a cache-write failure is logged, not treated as a provider failure
- **SmartAIVisionClient**: Cache-first; calls the configured provider only. Other vendors are tried (configured provider still first) only when `enableFallback` is passed or `ai.fallback === true` in the config (#245). The old default walked a fixed `ollama → openai → anthropic` chain, so an OpenAI user with a local Ollama got Ollama's answer and an outage billed a vendor, or a BYOK key, the user never chose. Strict `=== true`, because `config.json` is untyped and `"false"` is truthy
- **A page that grew or shrank is diffed, not refused (#282).** `VisualDiffEngine.compare`
  runs pixelmatch over the overlap and counts every pixel of the larger canvas outside it as
  changed (painted `diffColor` in the diff image). A transparent pad would not do:
  pixelmatch blends alpha against white, so it reads as unchanged beside a white page. Such
  a comparison never passes and carries `layoutChange { baseline, current }` (runner
  result, stored hosted result, every report format). Decoding is bounded:
  `MAX_DECODED_PIXELS` (1920 x 16384) is checked from the header before any pixel is
  allocated, and the padded canvas too; sharp's `limitInputPixels` is the backstop, but it
  also applies to `metadata()`, so the header is read by an unlimited instance
- **pixelmatch options are pixelmatch's (#283).** `DiffOptions.pixelThreshold` is its
  per-pixel `threshold` (default 0.1); `alpha` is only the diff image's opacity (it used to
  feed the threshold too). `includeAA: true` means "count anti-aliased pixels", so the
  runner passes `!antiAliasing`. There is no sampled early exit any more: every comparison
  is the full diff (deterministic, always a diff image), bounded by `MAX_DECODED_PIXELS`
- **Visual reports and the runner (#284).** Image links are relative to the report actually
  written (the default `.iris/reports/…` too, not the cwd). A comparison's `error` is the
  failure reason in every format (HTML line, JUnit `<failure message>`, Markdown `Error:`) and
  in local history (SQLite migration 2: `visual_test_results.error`, bounded and
  userinfo-stripped like hosted). Any `scheme:` page is used as given; only scheme-less
  patterns get the base URL. Local runs may open `file:` and `data:` (like a11y; hosted
  forces both off). Baselines belong to a page URL, so a test that compares two versions of
  a page serves them from one URL (`e2e/visual-diff-e2e.test.ts`), never two `data:` URLs
- **The keyboard tester addresses elements by marker (#285).** Arrow-key and Escape checks
  set a per-run attribute `data-iris-kbd-<nonce>="<kind>-<n>"` on each widget and use that attribute as the selector,
  removed in `finally`; the trap check's marker is per-run too (`data-iris-trap-<nonce>`). Selectors built from id and class were
  invalid for Radix ids (`radix-:r1:`), Tailwind classes and id-less elements, and ambiguous
  between look-alikes. Labels read `getAttribute('class')`: an SVG `<a>`'s `className` is
  an `SVGAnimatedString`, and `.split` on it aborted the whole a11y run
- **Keyboard verdicts come from the keyboard (#286).** Focus order is the real Tab sequence,
  failing only a positive tabindex (manual order) or a stop that is invisible where focus
  lands (ancestors walked: opacity is not inherited); `-1` is the roving-tabindex pattern
  and never fails. No page script can reset the browser's sequential-focus starting point
  (blur keeps it at an autofocused control; focusing `<body>` makes Tab skip positive
  tabindex), so the walk blurs and, when focus wraps to the document part-way, puts the
  stops after the wrap first; it ends on a second wrap, a repeated stop, or 200 stops (an
  informational interaction says so). Stops are the deep active element (shadow roots,
  same-origin iframes); the same stop twice in a row is pressed through (a cross-origin
  frame or closed shadow root). The Escape check focuses inside each dialog before Escape. The Escape check reloads
  the page (`load`, failure tolerated) when the trap check pressed Escape, since that closed
  every Escape-dismissible dialog first. Escape identity after a re-render is #491
- **The a11y runner isolates pages (#287).** A page that fails (navigation, timeout, a check
  that throws on hostile markup) is that page's result with `error` and an empty axe
  result; the other pages still run. `summary.pagesErrored` counts them, and an errored page
  is never a pass: not in `checkOverallPass`, history (`failed`, the reason kept; SQLite
  migration 3 adds `a11y_test_results.error`), the HTML report ("Could not
  be scanned"), JUnit (`<error>`), the MCP tool (a tool error) or `iris a11y` (lists them,
  exit 3 unless a scanned page has violations: those exit 4, `summary.scannedPassed`).
  The score covers scanned pages only (`null` when none was: an unscanned page has no
  violations and raised it). Errors are userinfo-stripped where they are made
  (`stripUserinfo`, src/report-encoding.ts). The report directory is created before
  writing. The hosted worker sets `failFast` (no browser time on pages whose results
  would be thrown away) and throws the page error itself, keeping fail-the-job semantics
- **A WCAG level is WCAG 2.2 (#290).** `wcagTags(level)` (src/a11y/wcag.ts) is the one
  table: the `iris a11y` `--tags` default, the MCP tool and hosted jobs. AA =
  `wcag2a, wcag21a, wcag2aa, wcag21aa, wcag22aa`; axe tags a rule with the version that
  introduced it, so 2.0 tags alone skipped `autocomplete-valid` and `target-size`. axe's
  `incomplete` is "needs review": MCP `needsReview`, a CLI count, the HTML report and
  JUnit `<system-out>`; never a failure. Hosted stored results do not carry it yet (#498)
- **One a11y verdict per page (#288).** The runner sets `passed` and `failureReasons` on
  every result (`withVerdict`: axe violations at `--fail-on`, a failed keyboard or
  screen-reader check, or an error), and everything reads it: `summary.passed` (the exit
  code), the HTML page heading (PASSED/FAILED plus reasons), JUnit (per page one testcase
  per check: `axe` fails only at the threshold and lists the rest as `<system-out>`,
  `keyboard`, `screen reader`; root counts are the emitted cases) and history (local and
  hosted `passed`). They used to decide separately, so CI could read `failures="0"` while
  the CLI exited 4
- **axe runs in an isolated world (#350).** `AxeRunner` (src/a11y/axe-integration.ts) runs
  `axe-core` over CDP: `Page.createIsolatedWorld` per frame, `runPartial` per frame,
  `finishRun` in the top frame's isolated world. It shares the DOM, not the page's JS, so a
  pinned `window.axe` or poisoned builtins cannot write the verdict (`@axe-core/playwright`
  ran in the main world: a pinned fake was reported as an axe-core pass). Child frames are
  found in the isolated world (`axe.utils.shadowSelect` -> `DOM.describeNode` -> `frameId`);
  an out-of-process frame needs its own `newCDPSession(frame)` (that call fails for
  in-process frames, which is how they are told apart). Arguments go as CDP values, never
  spliced into source. `toA11yResult` zod-checks the result: malformed is a page error.
  Functions sent to the page are strings, so `--coverage` instrumentation never reaches it
- **A failed analysis is not a verdict (#281).** The classifier answers an outage or a tripped
  breaker with a fallback (`analysisFailed: true`, `severity: 'medium'`). The visual runner
  grades such a comparison by its pixels (`estimateSeverity`), counts it in
  `summary.aiUnavailable`, and `iris visual-diff` prints `AI: unavailable for N comparison(s)`.
  Mapped as `moderate`, a full-page change passed the default `--fail-on breaking`
- **Diff-aware vision requests**: when the caller supplies a computed pixel diff, it travels as an optional third image (`AIVisionRequest.diff`) to OpenAI, Anthropic, and Ollama alongside a prompt sentence pointing at it. Absent a diff, provider payloads and cache keys are byte-identical to the two-image form. Expect ~30-50% more input tokens per call when it is present (issue #124)
  - The diff mask is preprocessed as **lossless PNG**, not the JPEG used for screenshots: pixelmatch marks unchanged pixels transparent, and JPEG has no alpha channel and blurs the region edges that make the mask worth sending. An empty diff buffer is treated as no diff

**Pricing (default, configurable):**
- Cost is computed from provider-returned token usage when available; the flat per-image rate below is the fallback (cache hits, Ollama, missing usage)
- GPT-4o: $2.50/1M input + $10/1M output tokens (fallback $0.002/image)
- GPT-4o launch snapshot `gpt-4o-2024-05-13`: $5/1M input + $15/1M output tokens (fallback $0.004/image) — it kept its launch price, so it must not inherit gpt-4o's rate (#243)
- Claude Sonnet 5: $3/1M input + $15/1M output tokens (fallback $0.0015/image) — the vision default
- Claude Haiku 4.5: $1/1M input + $5/1M output tokens (fallback $0.0005/image) — what the `ANTHROPIC_API_KEY` env path selects, so it is the model an out-of-the-box Anthropic user actually requests
- Claude Opus 5: $5/1M input + $25/1M output tokens (fallback $0.004/image)
- Ollama (local): $0.00
- Anthropic rows use the standard rate, not Sonnet 5's introductory $2/$10 (expires 2026-08-31): this table gates a budget circuit breaker, and over-reporting trips it early while under-reporting lets real spend outrun the tracked total
- **Model IDs rot, so they are no longer trusted blind (#184).** The whole `claude-3` family was retired while still pinned in five places, and the vision path was dead until #183. A guard test fails on any re-added quoted `claude-3-*` ID in `src/`. Since #184 every pin lives in `src/ai-client/models.ts` (`DEFAULT_MODELS.text` / `DEFAULT_MODELS.vision`) and is checked against the provider's live model list before use:
  - `listModels(provider, creds)` hits `/v1/models` (OpenAI, Anthropic) or `/api/tags` (Ollama), memoized per provider per process. It returns `null` for "could not check" — never an empty list — so a 401 cannot be mistaken for "no models exist". `IRIS_MODEL_PROBE=0` disables it; `jest.setup.ts` sets that so the suite stays hermetic
  - `resolveModel({provider, kind, model, creds})` returns a listed model as-is, rescues a **retired built-in pin** via longest-prefix match within the same family root, and throws `ModelUnavailableError` for a **user-named** model the provider does not serve. It needs no "was this explicit?" flag: a missing model that equals the pin is our rot, one that differs is the user's typo
  - `SmartAIVisionClient` rethrows `ModelUnavailableError` instead of stepping to the next vendor — that swallow is what made a retired model read as "all providers failed". Text clients resolve via `createResolvedAIClient()`; `loadConfig()` stays synchronous
  - `CostTracker` prices a model with no exact row by its family (#243), but only when the rest of the ID is one snapshot suffix (`-20260514`, `-2024-08-06`, `-latest`): a rescued successor (`claude-sonnet-5` → `claude-sonnet-5-20260514`) or dated snapshot gets its family's rate, while a variant (`gpt-4o-realtime-preview`, `gpt-4oz`) does not, because variants are priced differently. A snapshot that kept a different price needs its own row (`gpt-4o-2024-05-13`). Anything unmatched is charged the dearest registered rate per field (including `setPricing` rows), recorded with `estimated = 1` on its ledger row, and warned about once per pair. It used to record $0, which a budget breaker never trips on. A model dearer than every registered row still under-reports until it gets one. Free providers (Ollama) stay $0 for every model

### Workspaces and the Portal (issue #247)

The root `package.json` declares `"workspaces": ["apps/*"]`. The IRIS package stays
at the root and publishes exactly as before; `apps/portal` (`@iris/portal`) is
private. Things that are easy to break:

- **Root Jest ignores `apps/`** (`testPathIgnorePatterns` and
  `modulePathIgnorePatterns`). The portal has its own `next/jest` config.
- **The portal's ESLint config pins `settings.react.version`.** `eslint-config-next`
  sets it to `"detect"`, and detection is the one path in `eslint-plugin-react`
  (peer range stops at ESLint ^9.7) that calls `getFilename()`, removed in ESLint 10.
  Remove the pin and ESLint 10 crashes (`getFilename is not a function`).
- **`gray` is gone from the shadcn preset API** (400). The portal was scaffolded
  with `neutral` and its tokens replaced with shadcn's registry gray
  (`/r/colors/gray.json`). Adding components with `npx shadcn add` is unaffected.
- **`better-auth` is ESM-only**, and `src/auth/config.ts` loads it from the
  CommonJS build through `require(esm)`. `tsc` resolves its subpaths through the
  package's `typesVersions`. Jest cannot load it in-process: test through a spawned
  Node (see `auth-config.test.ts`), or add the whole dependency tree to
  `transformIgnorePatterns`. `createAuth()` requires `secret` and `baseURL`, because
  otherwise better-auth falls back to `BETTER_AUTH_*` or, outside production, to a
  built-in secret. Those variables are on the `jest.setup.ts` scrub list.
- **`.dockerignore` excludes `apps/`**, so the image never carries portal packages.
- **The root `package.json` pins `overrides.next`.** better-auth lists `next` as an
  optional peer, and npm installed a separate root copy for it that stayed on a
  vulnerable version after the portal moved (GHSA-vcvr-r3jv-pc5j). Bump the override
  together with `apps/portal`'s `next` and `eslint-config-next`: npm refuses
  (`EOVERRIDE`) when they disagree. Do not "fix" a stray copy with `npm dedupe`, which
  rewrote 4,000 lockfile lines and pulled a 12-hour-old release.

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

### Portal Accounts (issue #249)

Sign-up, verification, login and password reset run through BetterAuth in
`apps/portal`, over the shared `createAuth()`.

- **The account policy is in `createAuth()` and is merged key by key into the caller's
  `emailAndPassword` / `emailVerification` / `rateLimit`, policy last.** Neither the
  portal nor the API can relax a pinned key, and a caller's other keys survive (e.g.
  `rateLimit.storage` for #316). A whole-object spread would silently drop them. The
  policy does not lock `advanced` or `trustedOrigins`.
  - Verification is required, and verification mail goes out on sign-up **and on each
    correct-password sign-in of an unverified account**. BetterAuth only logs a failed
    send, so the re-send on sign-in is the recovery path for a lost or failed mail.
  - **No sign-in on verification** (login CSRF: a mailed link must not sign a browser
    into the sender's account).
  - Sessions are revoked on reset.
  - Rate limits are on in every environment (BetterAuth's defaults turn them on only in
    production).
  - `sendEmail` is required. Secure/httpOnly/SameSite=Lax cookies are BetterAuth's defaults *given* an
  https `baseURL`. The policy pins `advanced.ipAddress.ipAddressHeaders` only (#347),
  merged two levels deep: spreading a whole `advanced` would replace a caller's
  (e.g. `trustedProxies`, cookie options).
- **The portal imports `../../../src/...` directly.** Turbopack finds the workspace
  root from the root lockfile, and `pg` is on Next's default server-external list. No
  `transpilePackages` or workspace package is needed.
- **`getAuth()` is lazy, and a server page must `await headers()` before calling it.**
  If `getAuth()` runs first, Next prerenders the page at build time and the build
  fails for want of `SMTP_URL`.
- **Submit buttons stay disabled until hydration** (`useSyncExternalStore`). Before
  hydration, a native submit is a GET with the password in the query string. The E2E
  test pins this with JavaScript disabled.
- **Rate limits are per client IP from `X-Real-IP`** (#347), stored in memory (one
  portal process). The ingress overwrites it with the peer address. Served without
  the ingress (no header), production falls back to one shared bucket per path.
- **E2E** (`apps/portal/e2e`, `npm run e2e -w @iris/portal` after a build): real
  Postgres plus Mailpit, from docker-compose.dev.yml or the CI services. Things that bit:
  - The global setup runs `src/db/migrate.ts` as a child process, because Playwright's
    loader cannot link the ESM `kysely/migration`.
  - Each test sends a random `X-Real-IP`, not a counter: Playwright restarts
    the worker after a failure, which resets module state.
  - After a client-side link click, wait for the URL before `getByLabel(...)`. The old
    page may have a field with the same label.
  - Next's route announcer is also `role="alert"`. Match an alert by its text.
- **WSL: a connect to a closed 127.0.0.1 port hangs** (no RST, ~2 min) instead of being
  refused. `[::1]` refuses at once. It is the same blackhole as #382, and Playwright's
  already-running check pays it before every local E2E run.

### Terms and AUP (issue #276)

Drafts in `apps/portal/content/legal/{terms,acceptable-use}.md` (front matter `title`,
`version`, `draft`), public at `/terms` and `/acceptable-use`. `draft: true` shows the
"Draft — pending review; not yet in effect" banner; the owner removes it by deleting that
line once counsel approves. Placeholders are `[square brackets]`: no company name,
jurisdiction or address is invented. `lib/legal.ts` + `components/legal-document.tsx` are a
tiny renderer (headings, `-` lists, bold, links; React escapes text, links limited to site
paths and https).

- **The enforced versions live in `src/legal/versions.ts`** (`LEGAL_VERSIONS`,
  `ACCEPTED_TERMS` = `<terms>:<aup>`). A test fails if a file's front-matter `version`
  differs. Publishing a new version: see docs/runbook-production.md.
- **`terms_acceptances`** (migration 0006): one row per user, document and version, with
  `accepted_at` and `ip`; keyed by user, so it is the one IRIS table without `org_id`
  (`USER_SCOPED_TABLES` in the catalog test is the documented exemption; add to it only
  for a person-scoped table). `on delete cascade` from `"user"`.
- **Sign-up is enforced in `createAuth()`**: a `hooks.before` on `/sign-up/email` refuses
  with `400 TERMS_NOT_ACCEPTED` unless the body's `acceptedTerms` equals `ACCEPTED_TERMS`
  (so every caller, tests included, must send it), and `hooks.after` records the rows
  with the client IP. It is clickwrap: the server refuses a sign-up without the
  current-versions token, but a scripted client can still send it. `createAuth()` takes
  no `hooks` from its caller, and needs a `pg` Pool or `{ db }` Kysely as `database`.
  `socialProviders` is omitted from its options type (a test pins that): OAuth callbacks
  create users without passing `/sign-up/email`, so enforce acceptance there first.
  The rows are inserted only for a user row that exists: with email verification on,
  BetterAuth answers a duplicate-email sign-up with a made-up user, and that must neither
  log an error nor reveal that the address exists. The after-hook cannot undo the user: a failed
  write is logged and the user meets `/accept-terms` at the next page.
- **Re-acceptance**: `requireOrg()` redirects a user missing a current version to
  `/accept-terms` (server page + server action; the form carries the versions it was
  rendered for) which also needs the `agree` field (`on`), else it records nothing and
  returns to the page with an error; the IP is `getIP()`'s validated value. The gate covers
  portal pages (`requireOrg()`) only, by design for now: server actions on `/api-keys` and
  `/provider-keys`, BetterAuth's endpoints and invitation acceptance stay usable for a user
  who has not re-accepted. API keys and the RPC are unaffected.
- E2E uses a version bump simulated by aging the user's rows (`terms.spec.ts`).

### Privacy, subprocessors and DPA (issue #277)

Drafts at `/privacy`, `/subprocessors` and `/dpa` (`apps/portal/content/legal/{privacy,
subprocessors,dpa}.md`), same renderer and draft banner as #276; owner/counsel approval is
#450. `docs/legal/dpa-template.md` is a copy of `dpa.md` (a portal test keeps them equal).

- **`docs/data-flows.md` is the source of truth** for what is stored, where, for how long
  and what goes to which third party, each entry citing its code. A change that adds or
  alters a store, a personal-data field, a retention period or a transmission updates it in
  the same PR, and the privacy page / subprocessor table if customers can see the change.
  Undecided retention says "undecided (#349)"; never invent a period.
- **Their versions are `PUBLISHED_VERSIONS`** in `src/legal/versions.ts`, not
  `LEGAL_VERSIONS`: every key of the latter is one a user must accept (`acceptance.ts`
  iterates it), and these need no acceptance. `ACCEPTED_TERMS` is unchanged.
- The renderer also takes simple pipe tables (header, `|---|` row, cells through the same
  escaping `inline()`). `LegalFooter` (on legal pages and the `(auth)` layout) links all five
  documents; it is a `nav`, not a list, so the renderer's list tests are unaffected.

### Abuse Handling and Contacts (issue #348)

Operator suspension of an org, and the published contacts. Ops side: runbook "Abuse handling".

- **`org_suspensions`** (migration 0007) is an append-only history (`action` suspend /
  unsuspend, `reason`, `actor`); an org's state is its latest row, none means active.
  `orgSuspensions(db)` (src/org-suspension.ts) is idempotent and refuses an unknown org;
  `suspendedSql(orgId)` is the one predicate, usable inside other statements.
- **The reason is for operators only.** Tenants see "Organization suspended" (403 on the
  WS upgrade and on REST, `ORGANIZATION_SUSPENDED` from BetterAuth, the job's error),
  never the reason.
- **Enforcement points**: `apiKeyAuthenticator.verify` returns `'suspended'` for a valid key
  of a suspended org (403, not 401: the key is fine); `recheck` does too, so live
  connections close with 1008 within `authRecheckMs`. `claim` reads the org's state in the
  same statement, and the worker fails such a job unrun, no usage, counted `refused`
  (not `error`: the watchdog's rate is server faults only). The portal: `requireOrg()`
  exposes `suspended` (banner with the support contact); a BetterAuth `hooks.before`
  refuses `/api-key/create|update|delete` for a member of a suspended org (a non-member
  still gets the plugin's own refusal, so another tenant's state does not leak); the
  provider-key server actions refuse too. **Not instant, and not everything**: an open
  connection keeps working until its next re-check (up to `authRecheckMs`, 60 s), and a
  job already running finishes and is billed. Invitations, accepting one and switching
  orgs stay open (membership is not abuse; keys and jobs are what act on the world).
  A member of a suspended org cannot create a new org (`/organization/create` hook): a
  fresh org would carry new keys past the suspension. The api-key hook takes the org from the key for update/delete (the plugin acts on the
  key's own org whatever the body names) and from the body for create only.
- **Rows are stamped in lock order**, not by `now()`: a transaction that began first can
  take the per-org lock second, so each row is dated strictly after the org's latest
  row. Otherwise two operators acting at once can leave the earlier action current.
- **`iris admin suspend-org|unsuspend-org <orgId> --reason … [--actor …]`** and
  `org-status`: hosted only (exit 2), exit 3 when the database is unreachable, 1 for an
  unknown org. Actor defaults to `$SUDO_USER`/`$USER`.
- **Contacts are operator configuration**, never invented: `IRIS_SECURITY_CONTACT`,
  `IRIS_ABUSE_CONTACT`, `IRIS_SUPPORT_CONTACT` (`mailto:` or `https:`, validated;
  malformed throws). Unset shows a `[placeholder]` on `/contact`, and
  `/.well-known/security.txt` answers 404 without a security contact (RFC 9116 requires
  `Contact`). `Expires` counts from when the portal process first serves it
  (`IRIS_SECURITY_TXT_EXPIRES_DAYS`, 1-365, default 365): a deploy renews it, a portal
  left running a year lets it lapse. The production job passes the contacts from
  environment variables (optional).

### Portal Organizations (issue #250)

The org is the tenant (ADR 0001 §4). The organization plugin's options live in
`createAuth()`; its tables were already in migration 0001.

- **The personal org is made when a session is created, not at sign-up.** A
  `databaseHooks.session.create.before` hook sets `activeOrganizationId` to one of the
  user's orgs, creating one they own if they have none. Sessions need a verified
  address, so an abandoned sign-up leaves no org, and a failed creation is retried at
  the next sign-in. BetterAuth sets no active org on sign-in by itself. `createAuth()`
  therefore takes no `databaseHooks` from its caller.
- **Portal pages get their org from `requireOrg()`** (`apps/portal/lib/org.ts`), which
  calls BetterAuth with the session headers and no org id. Never read an org id from
  the request. A form rendered for that org sends its id back (`InviteForm`), because
  another tab may switch the session's active org between render and submit.
  BetterAuth still checks the caller's role in that org.
- **A refused org read clears the session's active org** (BetterAuth,
  `crud-org.mjs`). A request that names another tenant's org id therefore leaves the
  session with none, and `requireOrg()` moves it back to an org the user belongs to.
- **Refusals have different codes.** A non-member inviting into an org gets
  `400 MEMBER_NOT_FOUND`, not 403. Tests assert the error code, so a call refused for
  another reason (a missing `Origin` on a cookie POST, a validation error) cannot pass
  as a membership refusal.
- **BetterAuth's client follows `signIn`'s `callbackURL` after a successful sign-in.**
  The login form passes `?next=` (checked by `safeNext()`) as that URL. `new URL()`
  collapses dot-segments, so `/.//host` parses to the path `//host`, and `safeNext()`
  checks the parsed path as well as the origin.
- Tenants cannot delete orgs (`disableOrganizationDeletion`): `runs`, `usage_events` and the
  other tenant tables reference the org with no cascade. Operators do it with
  `iris admin delete-org` (#349, below).

### Portal API Keys (issue #340)

The api-key plugin (`@better-auth/api-key`, its own ESM-only package since 1.7) issues
**org-owned** keys: `references: 'organization'`, so a key's `referenceId` is the org id.
The portal page is `/api-keys`.

- **The org roles carry an `apiKey` resource** (`ac` / `roles` in `createAuth()`). The
  plugin checks it for every org-key operation, and BetterAuth's default roles do not
  have it, so without it only the org's creator could manage keys. Owners and admins
  create, update and delete; members only read. The roles are BetterAuth's defaults
  plus that resource, so the org permissions from #250 are unchanged.
- **Hashed at rest, shown once.** Only `create` returns the plaintext. List and get
  strip it, and the portal keeps it in component state only. Keys start `iris_` by
  default; an owner or admin may pass another prefix to create, so treat the prefix as
  a convention, not a guarantee. The list shows the first 11 characters (prefix plus 6
  random), set by `startingCharactersConfig`: the default 6 is the prefix plus one.
- **The plugin's own limiter is off.** Its default is 10 verifications per day, and
  `create` copies the setting onto each key row (`rateLimitEnabled`, `rateLimitMax`).
  Per-key limits are #342's. Rows created now carry `rateLimitEnabled = false`.
- **Revoke deletes the row.** The key stops verifying at once. A deleted key leaves no
  record; the audit log is #361.
- **A key outlives its creator's membership.** It belongs to the org and records no
  creator, so after removing an admin, rotate the keys they could have copied.
- `enableSessionForAPIKeys` stays off: a key must never become a portal session.
- **Do not let `npm install -w @iris/portal` pick the package's latest version.** It
  nested a second `better-auth` under `apps/portal`. Pin the range the root uses and
  check the lockfile diff.

### TLS Ingress (issue #347)

`deploy/nginx/iris.conf` is a site file for the host's existing nginx (it already owns
443), not a proxy container. The operator fills in `server_name`, the certificate
paths and the two upstream ports (iris-api `127.0.0.1:4000`, portal `127.0.0.1:3000`),
then `nginx -t` and reloads. `/v1/` (REST and WSS) goes to iris-api, the rest to the
portal. No host details in the repo (`repo-hygiene.test.ts`).

- **Overwrite, never append.** `X-Real-IP` and `X-Forwarded-For` are set to
  `$remote_addr`. `$proxy_add_x_forwarded_for` appends to the client's value, and
  BetterAuth (no `trustedProxies`) then trusts nothing and puts everyone in one
  bucket. `createAuth()` pins `ipAddressHeaders: ['x-real-ip']`, so a client-sent
  `X-Forwarded-For` never picks a counter, and pins `disableIpTracking: false` (no IP
  means no rate limit at all). Portal E2E therefore picks its counter with `X-Real-IP`.
  `X-Forwarded-Host` is overwritten too (Next checks server actions against it) and
  `Forwarded` cleared.
- **The portal must be reachable only through the ingress** (loopback bind, never a
  published or public port). In production a request without `X-Real-IP` lands in
  BetterAuth's shared `no-trusted-ip|<path>` bucket (sign-in: 3 per 10s for everyone
  at once), and any local process that reaches the port can name any `X-Real-IP`.
- **`X-Iris-Probe` is cleared.** Behind the proxy every peer is loopback, so a
  forwarded header would claim the healthcheck's extra slot (#342).
- **`add_header` and `proxy_set_header` inherit only into a location with none of
  its own.** The security headers live at server level only; `/v1/` needs
  `Upgrade`/`Connection`, so it repeats every `proxy_set_header`. A test checks each
  location, and nginx's own 429 (`always`).
- **`limit_req_zone` and `map` must be in `http {}`.** A site file is included there,
  so they sit at its top. Their names are global to the host's nginx: everything is
  prefixed `iris_` (a second `$connection_upgrade` fails `nginx -t`).
- **Throttle key is `$iris_client_key`**: IPv4 whole, IPv6 by its /64 (a map over
  the first 8 bytes of `$binary_remote_addr`; nginx's PCRE matches bytes). Keyed on the
  full address, one /64 holder rotates into 2^64 fresh budgets. The test feeds IPv6
  addresses through a test-only realip header (`X-Test-Client`, trusted from `::1`).
- **TLS 1.2 is ECDHE + AEAD only** (`ssl_ciphers`). On a shared 443 the handshake may
  be settled by the host's `default_server` before SNI picks this block, so the
  operator checks that server's `ssl_protocols`/`ssl_ciphers` too.
- **`/v1` (no slash) is a 301 to `/v1/`** from nginx, never proxied. Locations match
  the decoded path, so `/api/%61uth/` gets the auth throttle.
- **Throttles**: `/v1/` 5 r/s per client, burst 20 (an org's 300/min; counts upgrades,
  not messages); `/api/auth/` 10 r/s, burst 20 (BetterAuth's general 100/10s; its
  per-route rules still apply behind it). Reads 75s, above the 30s heartbeat.
- **Test** (`ingress.test.ts`): the template with only ports, upstreams and a
  self-signed cert substituted, in `nginx:1.29-alpine` on `--network host`. Required
  under `CI`, skipped locally without Docker. "Per IP" is shown with `127.0.0.1` vs
  `::1`. The image's OpenSSL refuses TLS 1.1 on its own too, so the TLS check pins the
  outcome, not the `ssl_protocols` line.

### Production Deploy (issue #273)

`deploy-production` (ci.yml) promotes digests; it never builds. Runbook:
`docs/runbook-production.md`. Compose: `docker-compose.production.yml` (iris-api, worker,
portal, postgres; every image pinned by digest, app images only from `${IRIS_IMAGE:?}` /
`${PORTAL_IMAGE:?}`).

- **The security boundary is the protected `v*` tag + the `production` environment's
  tag-only rule and required reviewer**, not the workflow. Without them a collaborator's
  branch workflow could run in `production` and read its secrets. The job runs only on
  a `v*` ref, for a dispatch too (no tag input: an input would let a branch run deploy).
- **`staged-<sha>` is a record, not a boundary**: deploy-staging tags both images
  (`imagetools create`, no rebuild) as its *last* step; anything with `packages: write`
  could move it. Staging runs token mode without worker/portal, so it proves the iris
  image boots (plus the portal digest serving `/login` on the runner), not the hosted stack.
- **One directory per release** (`releases/<tag>-<run>-<attempt>/`: compose, settings.env,
  per-release secrets); `shared/secrets/` holds pg_password, master_key, database_url
  (rewritten only if it differs: serving containers mount it). `current` is switched only
  once the new release is healthy (after the gates and the health wait), so a deploy cut
  off mid-way keeps its rollback target. Postgres is recreated only when its pinned digest
  changed (a deliberate upgrade, before the gates, not rolled back);
  rollback runs compose from the previous release's directory (its files, settings,
  images). Compose always runs from a release's **real path**, so bind mounts name that
  release's files; via the `current` link a restart would follow the link.
- **Migrations are forward-only; rollback relies on expand/contract.** `migrateToLatest()`
  succeeds as a no-op when the database has migrations the release does not know and all
  of its own are applied (an older release on a newer schema), and refuses when it also
  has pending ones (branched off before the newer release). Kysely alone throws
  "corrupted migrations" for both.
- **Health**: iris-api `GET /` -> 404 (the job API, before auth; the token check cannot
  authenticate in hosted mode, #309). Portal `/api/health` (dynamic, `no-store`): 200 only
  when getAuth() builds, the master key loads and `select 1` answers; 503 with no detail.
  Worker: `probeDatabase()` at startup (exit 3), heartbeat file written per poll and every
  30s during a job (`IRIS_WORKER_HEARTBEAT_FILE`), compose fails it at 180s.
- **Portal image** (`Dockerfile.portal`, context = repo root): Next `output:
  'standalone'` traced from the repo root (`outputFileTracingRoot`), server at
  `apps/portal/server.js`. Its ignore file is `Dockerfile.portal.dockerignore`, which
  only BuildKit reads (the legacy builder ignores it and fails on `apps/`). Keep
  `apps/portal/e2e` and `__tests__` in the context: `next build` type-checks them.
  `next start` (portal E2E) still works with standalone output.
- **The SMTP check is compiled separately**: `scripts/verify-smtp.ts` → tsc CommonJS
  into `/app/verify` (own `{"type":"commonjs"}`), plus `node_modules/nodemailer`
  copied in, since Next bundles nodemailer into chunks and does not trace it. It
  shares `lib/mail.ts` with the portal and has its own 15s timer (nodemailer waits 2
  min on a blackhole).
- **uid 1001 everywhere.** The portal image runs as `portal` (1001) like pwuser, so the
  deploy writes every app secret file once, owned by 1001. `pg_password` is 70.
- **`_FILE` secrets go through `readSecretEnv()`** (src/secret-env.ts): `resolveDatabaseUrl`,
  `resolveKeyring`, `hostedServices`' `BETTER_AUTH_SECRET`, and the portal's
  `BETTER_AUTH_SECRET` / `SMTP_URL`. Do not add another reader.
- **`deploy-script.test.ts`** pushes busybox images to a `registry:2` on a loopback port
  so refs are real digests, and stages release directories as the job does. COPY-only
  Dockerfiles (each RUN is a container: tens of seconds on a loaded WSL daemon) and
  `BUILDX_BUILDER=default` (CI's setup-buildx-action makes a docker-container builder
  current, which would not load the image). The worker uses the production compose
  file's own heartbeat check. Bash reads a script while running it: do not edit
  `deploy.sh` during a run.
- **Tag pushes already ran `build`** (`on: push` has no filter); adding
  `workflow_dispatch` leaves push/PR behaviour unchanged.

### Backups (issue #274)

`deploy/backup.sh` (daily, `deploy/systemd/iris-backup.timer`, as root) and
`deploy/restore.sh`; setup, restore and the drill log are in `docs/runbook-production.md`.
The deploy job ships both scripts and the units into each release directory; it never
runs or installs them. Object storage is #445.

- **Root runs only root-owned files outside the deploy tree.** The unit runs
  `/usr/local/sbin/iris-backup`, a reviewed copy the operator installs; settings,
  recipients, rclone config and the failure hook are in `/etc/iris`, backups in
  `/var/backups/iris`. The deploy user owns `/opt/iris-production`, so a root timer
  running `current/backup.sh` would be a root code path for the deploy key. The script
  finds postgres by compose labels (`docker exec`), not via a release's compose file.
- **`age` to public keys only**; the identity stays off the box. No recipients: it
  refuses, it never writes plaintext. The master key is backed up as its own file.
- **Atomic and fail-closed**: `pg_dump | age` into `<name>.tmp` under pipefail, renamed on
  success, the temp file removed by an EXIT trap. Retention runs only after a success:
  per kind the newest `BACKUP_KEEP_MIN` stay whatever their age (clock jumps), the rest
  go once older than `BACKUP_KEEP_DAYS`; both validated (`10#`, >= 1) before anything.
  rclone copies the whole directory (`--include` the two patterns), so a failed copy is
  retried by the next run.
- **Restore replaces the `public` schema in one transaction**: `begin; drop schema public
  cascade; create schema public;` then `pg_restore -f -` (SQL) into `psql`, and `commit`
  only if pg_restore succeeded (`psql --single-transaction` would commit at EOF even
  after pg_restore died). So a dump older than the schema leaves no later tables and the
  dump's `kysely_migration`. The file is decrypted to /dev/null first.
- **The serving-database check compares server identity, not URL text**:
  `system_identifier` from `pg_control_system()` plus `current_database()`, queried on
  both connections inside the container (libpq honours `%69ris`, `?dbname=`, addresses).
  An unreadable `database_url` or an unidentifiable database refuses without `--force`.
  URLs reach the container as files in a 0700 temp dir mounted read-only (`-e` would
  show in `docker inspect`); the password moves to `PGPASSWORD` inside.
- **`pg_dump -Fc` compresses**, so a plaintext marker is absent from an unencrypted dump
  too. The test checks the `PGDMP` magic instead, and the restore checks content.
- **`backup-script.test.ts`**: the Postgres healthcheck uses `-h 127.0.0.1`: the image's
  init-time server listens on the socket only and then restarts, so a socket check goes
  healthy early and the first connection is cut. `age` comes from PATH (CI installs the
  apt package) or the pinned, checksummed release tarball cached in the temp dir. Each
  restore is one container start (~30 s on a loaded WSL daemon).

### Observability (issue #275)

`src/log.ts` and `src/metrics.ts`, no dependencies. Ops side: runbook "Monitoring and
alerts".

- **Logs go to stderr, always** (`console.error`): JSON in hosted mode, `[iris] msg
  k=v` locally. stdout is program output; `api-key-auth.test.ts`'s probe parses its
  stdout as JSON, and a log line there broke it. Level from `IRIS_LOG_LEVEL`, read per
  call; default `info` hosted, `warn` locally (local `iris connect` prints no request
  lines). Tests spy `console.error`; the variable is on the `jest.setup.ts` scrub list.
- **Never pass a secret.** Log `keyId`, never the key; action *types* (from the results),
  never selectors or `text`. `redact()` is a net, not the rule: secret-named fields (incl.
  `text`/`value`/`instruction`/`params`/`body`), and in strings (error messages too) URL
  userinfo, `Bearer`/`Basic …`, secret-looking query params (`?token=`, `sig`, `auth`…)
  and `iris_<16+ alnum>` keys. Errors are logged as their message only.
- **Modules shared with the local CLI** (translator, AI clients, cost tracker, usage
  ledger, Postgres pool) print through `hostedLog(level, msg, fields, () => console…)`:
  JSON hosted, their old console output locally. `observability.test.ts` fails on a bare
  `console.*` in those files.
- **Logging is synchronous**, so request lines add no await ahead of the SessionGate
  (#128). The RPC line is written after `reply()`; the REST line on `res` `'close'` (a
  test reads it ~50 ms after the response). Once the server has closed, request lines
  are counted but not printed ("Cannot log after tests are done").
- **Pre-dispatch refusals are throttled per connection** (rate-limited, unparseable,
  not-a-request): one line per 10 s carrying `suppressed`, a summary on close; every one
  is still counted. They cost a client nothing, so unthrottled they flushed the logs.
- **REST `requestId` is always ours** (also the `X-Request-Id` header); a safe client
  `X-Request-Id` is logged as `clientRequestId` only (it could collide).
- **Bounded labels only**: RPC method from a fixed set (else `unknown`), REST route with
  the id folded (`GET /v1/jobs/:id`), outcome `ok|client_error|rate_limited|error`. No
  org id on any series; `usage_events` is the per-org record. `-32600/-32601/-32602`
  and tenant-caused `-32000`s (thrown with `refused: true`: no session, session limits,
  closed during launch) are `client_error`; other codes are `error`. `executeBrowserAction`
  answers every failure as `{ success: false, error }`; its outcome rides beside the reply
  in a `WeakMap` (`tagged()`): a throw caught there (launch, page, dead browser,
  translation) is `error`, missing instruction/actions `client_error`, a failed action
  `ok`. A REST response the
  client abandoned is `aborted`. The watchdog's rate is error / (ok + error), so no tenant
  can raise or dilute it.
- **One process-wide registry** (`metrics`). `startServer` re-registers its gauges
  (sessions, browsers) on each call, so with several servers in one process the last
  wins. `iris_errors_total` counts every `log('error', …)` call, printed or not.
- **AI spend** is counted in the translate `onUsage` callback, which is now attached for
  every tenant request, ledger or not (`protocol-auth.test.ts` asserts it).
- **The metrics listener refuses non-loopback hosts**, so in a container it is reachable
  only from inside it (a published port reaches the container's interface, #192). That is
  why compose publishes nothing for 9464/9465 and the watchdog scrapes with `docker exec
  <c> node -e fetch(...)`. Do not "fix" it by binding 0.0.0.0.
- **BetterAuth's logger** is pinned in `createAuth()` (`logger` is omitted from its
  options type): an `APIError` with `INVALID_API_KEY`, `KEY_NOT_FOUND`, `KEY_DISABLED`,
  `KEY_EXPIRED` or `USAGE_EXCEEDED` drops to info; anything else stays at its level. Only
  string and error-message arguments are logged (BetterAuth may pass rows).
- **Watchdog** (`deploy/watchdog.sh`, root timer every minute, installed like the backup):
  restarts `unhealthy` containers (Docker never does; `unless-stopped` acts on exit only),
  capped per service per hour; alerts on Docker's own restarts (`RestartCount` up), failed
  scrapes and the error share over a 5-minute window (samples in `/var/lib/iris-watchdog`
  with `iris_start_time_seconds`; a new start time or counters below the *latest* sample
  restart the window; times after now are dropped, so a clock stepping back neither
  counts nor suppresses). Container text in alerts is cut to one printable line (300).
  A container gone between `ps` and `inspect` is skipped (`|| continue`, `set -e`). Alerts: `logger -p crit -t iris-watchdog`
  plus `/etc/iris/alert-hook <key> <message>`, repeated per key only after
  `WATCHDOG_ALERT_REPEAT`. `container-config.test.ts` checks the script's default targets
  against the compose `--metrics-port` values.
- **`watchdog-script.test.ts`** runs `node:24-alpine` containers with compose labels; a
  healthcheck on `/tmp/sick` makes one unhealthy on demand, and the file survives a
  restart, which is how the cap is reached. `logger` and the hook are PATH/file stubs.
  ~90 s on a loaded WSL daemon.

### Container Deployment (issue #192)

`Dockerfile`, `.dockerignore`, `docker-compose.staging.yml` and
`docker/healthcheck.js` ship IRIS as a container. These constraints are easy to
break and expensive to rediscover:

- **Base image is `mcr.microsoft.com/playwright:v<version>-noble`**, tracking the
  `playwright` version in package.json. It carries Chromium *and* its system
  libraries, so no `playwright install --with-deps` at build time. Verified to
  ship Node v24.18.1, satisfying the `engines` floor. Keep the tag in step with
  the library — they are matched pairs.
- **Three stages, deliberately.** `better-sqlite3` has no prebuilt binary here
  and needs node-gyp, which the Playwright image has no `make` for; the compiler
  goes in a `deps` stage and never reaches the shipped image. That stage runs
  `npm ci --omit=dev --ignore-scripts` then `npm rebuild better-sqlite3`, because
  the full lifecycle fails: `"prepare": "npm run build"` needs TypeScript, which
  `--omit=dev` has just removed.
- **The container binds `0.0.0.0`, the host publishes on `127.0.0.1`.** Docker
  forwards a published port to the container's network interface, not its
  loopback, so a loopback bind inside the container refuses every connection
  while looking healthy. The security boundary is the host-side mapping.
- **`shm_size: 1gb`.** Chromium exhausts Docker's 64 MB default and the crash
  reads as an opaque browser disconnect.
- **Sandboxed Chromium needs `docker/seccomp-chromium.json`.** Every launch goes
  through `launchBrowser()` / `newHardenedContext()` in `src/browser.ts` (#331):
  sandbox on, Playwright's signal handlers off, downloads and service workers
  blocked. A guard test fails on any other `chromium.launch` / `browser.newContext`
  in `src/`. Docker's default seccomp allows `unshare`/`setns`/`clone`-with-namespace
  flags and `chroot` only to a container holding `CAP_SYS_ADMIN` / `CAP_SYS_CHROOT`,
  and compose drops every capability (#332). The profile is Docker's default
  (moby/profiles v0.2.3) plus one rule allowing those four. Do not swap in
  Playwright's published profile: it predates `clone3`, which then gets EPERM, and
  glibc falls back to `clone` only on ENOSYS. The deploy probe launches through the
  factory, so it proves the sandbox on the real host.
- **Runtime hardening lives in `docker-compose.staging.yml` (#332)**: `init`,
  `cap_drop: ALL`, `no-new-privileges`, `read_only` with tmpfs for `/tmp` and
  `/home/pwuser`, memory/CPU/pids limits, `stop_grace_period` above the server's
  5s force-exit. `__tests__/container-config.test.ts` pins each one. Measured in
  this image: ~20 pids for the idle server, ~60 more per browser session.
- **The token is a compose secret file**, `IRIS_CONNECT_TOKEN_FILE`, not an env
  var (`docker inspect` shows env). It is a bind mount, so the host file's owner
  and mode apply: readable by uid 1001, inside a 0700 directory.

The healthcheck completes an authenticated JSON-RPC round trip rather than a TCP
open — the socket listens long before the browser layer is usable. It lives in a
file because compose interprets `${...}` in an inline script as its own syntax.

### Hosted Mode URL Policy (issue #334)

`IRIS_HOSTED` is read once by `isHostedMode()` (src/hosted.ts), memoized, and fails
closed: anything but unset, `''`, `0` or `false` is on. Under it,
`assertNavigationAllowed()` forces `blockPrivateHosts: true, allowFile: false,
allowData: false` over whatever policy its caller passed. The override lives in that one function
on purpose: the navigate action, the per-request CDP guard and the MCP pre-flight
all end up there, so no caller has to remember it and none can relax it. The
page's WebSocket route (`routeWebSocket`, which CDP Fetch cannot see) is installed
with every guard, not only under a pin, and refuses whatever that function refuses. Local
mode is unchanged, and `run` / `watch` have an opt-in `--block-private-hosts`.

- The protocol suite runs under `IRIS_HOSTED=1`, set at the top of the file. Tests
  that need to reach a loopback page go in its "local mode" block, which loads
  its own server through `jest.isolateModules`.
- The switch is memoized per module registry. A test that needs it on or off has
  to read it inside `jest.isolateModules`, or spawn a process with the variable set.
  Setting `process.env` after the first read does nothing.
- The visual and a11y runners install the guard on every page before navigating
  (#335). Visual passes `{}`; a11y passes its `urlPolicy`, or when unset
  `{ allowFile: true, allowData: true }` so the CLI can still scan local files and
  `data:` pages. The MCP tool passes `{}`. Hosted mode overrides all of them.
- Under `jest --coverage`, a *function* passed to `page.evaluate` fails in the
  browser with `cov_* is not defined`. Pass a string expression, as
  `src/visual/capture.ts` does (also for `waitForFunction`), or exclude the module from coverage as the a11y
  modules are.
- Hostnames that *resolve* to private addresses are the egress proxy's job, below.

### URL Guard: Popups, Pins, Opaque Starts (issue #337)

`installUrlPolicyGuard()` now has three layers, and each exists because the others
cannot see something:

- **Page CDP session** — every request of the page, including redirect hops.
- **Context route** — a popup's opening request, which arrives before the popup's
  own session can attach. Playwright continues *redirect hops* inside its own Fetch
  handler (`redirectedFrom` → `Fetch.continueRequest`), so a route never sees them.
- **Browser net** (`browser.newBrowserCDPSession()`, one per Browser) — `Fetch`
  on Document requests of every target plus `Target.setDiscoverTargets`. A popup's
  `targetInfo.openerId` names its opener (the page target, even when a
  cross-origin iframe opened it), so its opening request *and every redirect hop*
  are judged by the opener's live policy (`GuardDecision.attribution: 'opener'`).
  Skipped when `context.browser()` is null; mocked contexts return null for it.

Constraints that are easy to break:

- Do not hold a popup's opening request until the `page` event: the event waits
  for that request, so it deadlocks.
- Live popups per guarded context are capped (`MAX_POPUPS_PER_CONTEXT`). An
  over-cap popup is still registered (so popups opened *through* it find a guarded
  opener and hit the cap too), its requests are refused, and the browser net closes
  it right after refusing its first request. Never `Target.closeTarget` at
  `targetCreated`: closing a target Playwright is still attaching to stalled the
  opening click in 2 of 3 runs. Its guard install also closes it (`page.close()`).
- A pinned origin now refuses **every** cross-origin request, images and fonts
  included: an image URL is a write channel for a filled-in secret. The explicit
  allowance is `--allow-cross-origin`.
- `runAgentLoop` with pinning on refuses to start from an opaque origin
  (`about:blank`, `data:`), returning `terminationReason: 'error'`, and
  `checkAction` refuses too. Agent-loop tests therefore serve their fixture from a
  local http origin, not a `data:` URL.

### Agent Loop Verdict (issue #351)

`runAgentLoop`'s `goalMet` is the AND of the checks made after the agent's last
*executed* action (success or failure: a failed click may still have been dispatched).
Acting again clears it to `null` until the next check; a policy-refused action never ran
and clears nothing. It used to be the latest asserting turn's checks, so a turn-1 pass
survived seven turns of clicking and `iris run --agent` reported success at `max_turns`.
One-shot `iris run` still ANDs every assert in the plan (plan 013's contract).

### Hung Pages and Provider Failures (issue #293)

- **`AITranslationResponse.error`** is set by the text clients when the provider could
  not be asked or its reply could not be read (unreachable, HTTP error, not JSON, empty).
  `actions` is then empty. A reply that parsed but proposed no or schema-invalid actions
  is a plan, not a failure, and leaves it unset. `runAgentLoop` ends `error` on it at
  once; it used to retry it as an empty plan and report `no_actions`. `translate()` does
  not carry it yet, so `iris run` / RPC still read an outage as an empty plan (#294).
- **`page.title()`, `page.evaluate()` and `page.addStyleTag()` take no timeout** and wait
  forever on a page spinning its main thread. Go through `src/page-timeout.ts`:
  `withPageTimeout(call, fallback, ms)` (2 s default; a rejection still rejects) or
  `addStyleTagBounded()` (throws on timeout: a capture without its mask would show what
  the mask hides). Locator calls, screenshots and `waitForFunction` have their own.
- **The a11y runner has one deadline per page** (`pageTimeoutMs`, default
  `A11Y_PAGE_TIMEOUT_MS` = 120 s) instead of bounding its ~20 `evaluate` sites: a hang is
  not a throw, so #287's page isolation never fired. The hung page is abandoned and closed
  with the browser at the end of the run; the next page gets a fresh context.
- Tests: `__tests__/hung-page.test.ts` (real Chromium, `setTimeout(() => { for (;;) {} })`,
  with a positive control that the page really is hung). Closing a context whose renderer
  spins can take seconds under load, hence the 15 s `afterEach`.

### Hosted Egress Proxy (issue #336)

Under `IRIS_HOSTED`, `launchBrowser()` points Chromium at an in-process HTTP/CONNECT
proxy (`src/egress-proxy.ts`, one per process, started on first launch). It is the
only layer that sees worker and SharedWorker requests, and the only one that sees
resolved addresses: it resolves the target once, refuses it (403) if **any** answer
is private, reserved or metadata (`isBlockedAddress()`, the same range tables), and
dials the address it vetted, so a rebinding resolver gets no second lookup.

- `bypass: '<-loopback>'` is passed explicitly. Chromium sends loopback direct past
  any proxy unless told otherwise; Playwright adds the rule itself but drops it when
  `PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK` is set.
- `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`: UDP cannot be proxied,
  and STUN to an internal host:port otherwise goes straight out.
- Tests substitute DNS and dialing through `hostedEgressProxy({ lookup, connect })`,
  called before the first launch in the registry. `connect` sends the one "public"
  test address (`8.8.8.8`) to a local server, so every refusal has a positive control
  that goes through the same proxy. A refused target must leave no hit on the server.
- Not covered: a container-level egress firewall, and names Chromium resolves for DNS
  prefetch (a lookup, no connection).

### Report Output Encoding (issue #339)

Every report field that is not a number may hold text the page under test
controls: page names, axe output (axe runs *inside* the page) and model output
quoting the page. Both report writers route every interpolation through
`src/report-encoding.ts`; do not add a local escaper.

- **XML**: characters XML 1.0 forbids (C0 controls, lone surrogates, U+FFFE/FFFF)
  have no escape; `escapeXml` replaces them with U+FFFD. TAB/LF/CR go out as
  character references so attribute values keep them.
- **Markdown**: inline punctuation is backslash-escaped and newlines fold, but a
  value placed after a list marker still starts a block, so leading whitespace is
  dropped and a leading `-`, `+`, `1.` is escaped. Bare URLs may still autolink
  under GFM; the target is then the visible text.
- **Links**: `safeHref()` allows http(s) only. Attribute escaping does not make a
  `javascript:` URL inert.
- **Tests** assert *structure equivalence*: one report rendered with benign and
  with hostile strings must parse (Chromium DOMParser, markdown-it) to the same
  element/token sequence. Substring checks pass on half-escaped documents.
- Writing `\u....` escapes through a tool call can land as the raw character on
  disk. Check with `cat -A` when editing a regex or fixture that uses them.

### RPC Server Error Policy (issue #330)

`iris connect` installs `installProcessErrorPolicy()` (src/protocol.ts), and the
split is deliberate:

- **Unhandled rejection → log and keep serving.** Rejections come from per-request
  async work. Node's default (crash) is how one malformed frame used to end every
  client's session.
- **Uncaught exception → log and exit 1.** A synchronous throw that escaped every
  handler leaves shared state unknown. Playwright kills its browsers on exit.

Two rules keep the server alive under hostile input. Validate a frame's *shape*
before reading from it: `null`, `1`, `[]` and `"x"` are all valid JSON, and get
`-32600` with `id: null`. And send only through `reply()`, which checks
`readyState`. `connect` announces "listening" only after the `listening` event;
a taken port exits 3.

Test it out of process. Jest absorbs an unhandled rejection, so an in-process
test passes against the very crash it is meant to catch.
`protocol-robustness.test.ts` spawns `src/cli.ts` through ts-node
(transpile-only) rather than `dist/`, so it never races the MCP suite's `tsc`.

### RPC Server Limits (issue #338)

`startServer(port, { limits })` takes any subset of `ServerLimits`; the rest come
from `DEFAULT_SERVER_LIMITS` (src/protocol.ts). `iris connect` exposes the four an
operator sizes a box by: `--max-payload`, `--max-connections`, `--max-sessions`,
`--max-actions`.

- **Origin, token and the connection cap run in `verifyClient`**, before the
  upgrade. A refused client gets HTTP 403 / 401 / 503 and never becomes a
  `wss.clients` entry. It used to be accepted and closed with `1008`. A test for a
  refusal listens for `unexpected-response`. Calling `terminate()` there emits
  `error`, so the test needs an error listener too.
- **`maxSessions` is server-wide.** A connection has at most one session (launch
  replaces it). Each connection has its own `SessionGate`, so the gate does not
  order the shared map. The cap's check and `sessions.set` must stay free of
  awaits between them, which is why `createBrowserSession` is synchronous.
- **Timings are clamped, not rejected.** Omitted values are filled from
  `EXECUTOR_DEFAULTS` (src/executor.ts) first, so an operator ceiling below a
  default still applies. A `jest.mock('../src/executor')` that loads the protocol
  must re-export `EXECUTOR_DEFAULTS` (see `protocol-leaks.test.ts`).
- **Heartbeat tests use `autoPong: false`** on the client, which makes a half-open
  peer as the server sees it.
- **Work can outlive its socket.** A queued `launchBrowser` or an in-flight action
  can resume after the socket's `'close'` cleanup has run. So launch refuses to
  insert unless the socket is `OPEN`, and an action refuses to create a page once
  `cleanupSession` has cleared `session.isActive`. Without those, the first leaves
  a phantom session holding a `maxSessions` slot for 30 minutes, and the second
  launches a Chromium nothing reclaims. Tests hold the fake Ollama answer to open
  that window on demand.

### Hosted RPC Authentication (issue #341)

Under `IRIS_HOSTED`, `iris connect` authenticates **org API keys**
(`Authorization: Bearer iris_…`) through `startServer({ authenticate })`, and the shared
`IRIS_CONNECT_TOKEN(_FILE)` is refused at startup (exit 2), not ignored. Missing
`BETTER_AUTH_SECRET` / `BETTER_AUTH_URL` / `DATABASE_URL(_FILE)` exits 3.
`hostedServices()` (src/api-key-auth.ts) builds the shared `createAuth()` over
Kysely and calls `verifyApiKey`; the key's `referenceId` is the org.

- **`verifyApiKey` cannot tell a backend failure from a bad key.** The plugin catches
  every error (timeout, locked table, its write on a read-only database) and returns
  `valid: false, code: INVALID_API_KEY` either way. So a refusal is believed only when
  `keyIsUsable()`, a read-only lookup of the key's row by the plugin's own
  `defaultKeyHasher`, agrees it is gone, disabled, expired or used up. Otherwise the
  authenticator throws: `503` at the upgrade, "keep the connection" at a re-check. A
  `select 1` is not enough: it succeeds while the `apikey` table is locked.
- **The auth pool has a query timeout** (`createPostgresDb(url, { queryTimeoutMs })`):
  a stalled query would otherwise hold an upgrade slot and stall every later re-check.
  Migrations keep the unbounded default. Hosted startup probes the database (exit 3).
- **The check is async inside `verifyClient`.** Upgrades still being verified count
  against `maxConnections` (`verifying`), or a burst of slow checks would all be
  admitted. Decrement right before `done()`: ws adds the client synchronously.
- **Revocation ends live connections** on a timer (`authRecheckMs`, default 60 s),
  closing with `1008` and reclaiming the browser at once. Not per message: an await
  ahead of the `SessionGate` would reorder pipelined messages (#128). The re-check is
  `Authenticator.recheck(principal)`: a read-only lookup by key id and org
  (`postgresKeyStore().isLive`), because `verifyApiKey` writes `lastRequest` and spends
  `remaining` on every call. A connection keeps no plaintext key (#342).
- The principal rides on the connection and its `BrowserSession`. Hosted `getStatus`
  counts only the caller's org sessions.

### Tenant Limits (issue #342)

`ServerLimits` gained four hosted-only limits: `keyRequestsPerMinute` (120),
`orgRequestsPerMinute` (300), `maxSessionsPerOrg` (2), `maxConnectionsPerOrg` (8).
They apply only to connections with a principal; local mode is untouched.

- **Rate limits are token buckets keyed by key id and org id** (`RateBuckets` in
  src/protocol.ts), checked synchronously before dispatch, not after an await (#128).
  Both buckets must have a token before either is spent. A refused request gets
  `-32029` with `data.retryAfterMs` and never runs. Buckets outlive connections, so
  reconnecting gains nothing; full buckets are pruned on the heartbeat. In memory, one
  process (#316 for several).
- **The per-org connection cap is checked in the async `verify` callback**, against
  `tenants`. That is safe only because ws emits `'connection'` synchronously inside
  `done(true)` and the handler registers the tenant before returning.
- **The api-key plugin's own limiter stays off for good.** It limits verifications,
  not requests, and every key row created so far has `rateLimitEnabled = false`, so
  turning it on would need a backfill migration (#340 comment). No backfill is needed.
- **The healthcheck probe slot**: a loopback peer sending `X-Iris-Probe: 1` gets one
  connection beyond `maxConnections`. Loopback only: a published port arrives on the
  container's interface. The test reaches the server through the host's own interface
  address to prove a remote header gets no slot. It serves the token-mode deployment
  (staging); the healthcheck cannot authenticate in hosted mode at all yet (#309).
- **Buckets run on `performance.now()`**, not `Date.now()`: the WSL2 clock steps
  backward (#190), and a negative elapsed time would drain a budget. A malformed frame
  from a tenant spends a token too (the check runs before the shape check).
- Per-IP pre-auth throttling is the ingress's `limit_req` (#347), not the server's:
  behind the proxy every peer is loopback.
- `startServer` itself does not enforce hosted mode: `protocol.test.ts` runs under
  `IRIS_HOSTED=1` with a token or no auth. `iris connect` is the enforcing caller.
- Tests: `protocol-auth.test.ts` (seam, in-test key table) and `api-key-auth.test.ts`
  (real Postgres, spawned hosted `iris connect`, keys made through BetterAuth).

### Billable Usage Ledger (issue #263)

- **`usage_events`** (migration 0003): kinds `browser_minutes`, `text_call`,
  `vision_call`, `agent_turn`, `a11y_job`, `visual_job`; `unit_cost_usd` (the provider
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
  turns (#428, the agent loop is CLI-only).

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
- Not enforced yet, no hosted surface: agent turns (CLI-only, #428), vision calls (hosted
  jobs run no AI), storage (#315).

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
- ponytail: a call is admitted while any credit is left, so the overshoot is the cost of
  the org's calls in flight; the operator's CostTracker budget still reserves per call (#244).
  Stripe reporting of managed usage is #264.

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
  loop still beats is never reaped (#442). During a rollout, a pre-0005 worker finishes
  without a token check until it is recreated (seconds; usage stays idempotent).
  Polling, not LISTEN/NOTIFY.
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

### Portal Runs Pages (issue #270)

`/runs` and `/runs/[id]` in `apps/portal`, reading the org's runs straight from Postgres
(ADR 0001: the portal never calls the public API). Visual diff images and approval are #463.

- **The portal imports `src/run-reads.ts`, not `src/history-store.ts`.** The read path
  (types, keyset cursor, `listPage`, `get`) lives in `run-reads` with no dependency beyond
  Kysely; `history-store` uses and re-exports it. Importing `history-store` pulled the
  a11y runner (Playwright) into the portal bundle and broke `next build` on
  `src/ai-client.ts`'s type re-exports.
- **The org comes from `requireOrg()` only**, so another org's run id is `notFound()`.
- **The list's `loading.tsx` lives in a `(list)` route group.** A `loading.tsx` at `/runs`
  also wraps `/runs/[id]`: the page streams, and `notFound()` then arrives after a 200.
  The group's `layout.tsx` runs `requireOrg()` above that boundary, so a signed-out or
  terms-pending visitor gets a real 307, not a 200 with a meta refresh. `requireOrg` is
  wrapped in React `cache()`, so the page reuses the layout's answer.
- **A failed job's detail shows its `error`** (`run-reads` `get()` selects it, the API too):
  a job that could not run has no summary and no results, only that reason.
- **The error page calls `retry()`** (Next 16: refresh, then reset). `reset()` alone re-renders
  the same failed result.
- **Filters and paging are links** (no client script); a bad or stale cursor shows a
  message with a link back to the newest page, not an error page.
- Run detail goes through `redactStrings()` (src/log.ts), the same pass as the API (#269).
- `lib/run-format.ts` turns a stored result into words per run kind; unit-tested.
- **Visual runs show their screenshots (#463)**: artifact keys are taken out of the results
  before redaction and signed (`visualImages()` in `lib/runs.ts`, the API's
  `signRunArtifacts`, only with `IRIS_S3_*` in the portal), then rendered as baseline /
  this run / differences with alt text naming page and device. A failed comparison gets an
  **Approve as new baseline** form only when `hasPermission({ visualBaseline: ['approve'] })`
  passes (owners and admins, a `createAuth()` role resource); the server action checks it
  again, refuses a suspended org, and calls `approveVisualResult()` from
  `src/visual-baselines.ts` (the lean module the API uses too: never `history-store`).
  Approval writes the baseline row and an `audit_log` row (`visual_baseline.approve`) in one
  transaction; `approved_by` is `user:<id>` from the portal, `key:<id>` from the API.
- Portal E2E has a SeaweedFS bucket of its own (`iris-portal-e2e`, made by global setup);
  `IRIS_TEST_S3_*` default to docker-compose.dev.yml's.

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
  Baselines stay until the org is purged (older runs link them).
- **Not purged**: live orgs' AI ledger rows (no period decided).

### BYOK Provider Keys (issue #344)

- **Envelope encryption** (src/byok/crypto.ts): each stored key gets a fresh AES-256-GCM
  data key, wrapped by a master key from `IRIS_KEY_ENCRYPTION_KEY(_FILE)`
  (`id:base64` entries, the first seals; generate with
  `echo "k1:$(openssl rand -base64 32)"`). Both layers take `(key id, org, provider)` as
  AAD, so a row copied to another org or relabelled does not open. Each blob names its
  master key: rotate by listing the new key first, running `node dist/byok/rewrap.js`
  (`rewrapAll()`), then dropping the old key. Opening requires the full 16-byte tag and a
  minimum blob length (GCM otherwise accepts 4-byte tags), and the master key's base64
  is parsed strictly (Node skips invalid characters, so a typo could decode to 32 bytes
  of a different key).
- **`providerKeyStore(db, keyring)`** (src/byok/store.ts): `set`/`remove`/`list` per org
  (format-checked, OpenAI and Anthropic only, per #258), and `credentialsFor(orgId)`,
  the only way the plaintext leaves. With both vendors stored, the one saved most
  recently is used, until #346 adds an org AI setting.
- **Hosted `iris connect`** resolves `aiCredentials` from the store, and refuses to start
  without the master key (exit 3, ADR 0001 §5).
- **Roles**: `createAuth()` has a `providerKey` resource; owners and admins create and
  delete, members read.
- **Portal `/provider-keys`**: server actions (`app/provider-keys/actions.ts`) ask
  BetterAuth `hasPermission` for the org the form names (it checks the caller's own
  membership in that org, not the active org), then call the store. An empty org id
  is refused first: BetterAuth would read it as the active org. `lib/provider-keys.ts`
  imports `server-only`, since it holds the master keyring. The forms
  POST even before hydration, so a key never lands in a URL. The portal needs the same
  master key as `iris connect` (`IRIS_KEY_ENCRYPTION_KEY`, set by `playwright.config.ts`
  for E2E).
- **E2E forgery needs the server-rendered form.** A hydrated client form's DOM drops the
  server-action fields, so re-submitting its `outerHTML` never reaches the action. Take
  the hidden `$ACTION_*` fields from the SSR HTML and POST them as multipart, with a
  positive control from an authorised session.

### Per-Request AI Credentials (issue #258)

- **`AICredentials { provider, apiKey?, endpoint?, model? }`** (src/ai-client/credentials.ts)
  is one tenant's credential for one request. `configFromCredentials(creds, { kind,
  fallback })` builds the client config from it alone: no env, no `.env`, no
  `~/.iris/config.json`, no other vendor's key, and `fallback` only from the caller (the
  org's opt-in), never the process config's `ai.fallback`.
- **`translate(…, { orgId, credentials })`**: `credentials` is an `AICredentials`, `null`
  (the tenant has no AI: pattern translation only), or a function asked only after
  patterns miss. Omitted is local mode, the process configuration, **except under
  `IRIS_HOSTED`, where omitted means `null`**: a caller that forgets them must not spend
  the operator's keys (ADR 0001 §5).
- **Injected credentials refuse `endpoint` and `ollama`**: AI clients fetch from the
  server process, outside the browser egress controls (#336), so a tenant-chosen URL
  would be an SSRF.
- **The SDK clients pin `authToken: null` (Anthropic) and `organization`/`project: null`
  (OpenAI)**: left undefined, the SDKs read `ANTHROPIC_AUTH_TOKEN` (sent as a second
  credential next to the tenant's key) and `OPENAI_ORG_ID`/`OPENAI_PROJECT_ID` from the
  process. Those variables, and the SDKs' `*_BASE_URL`, are on the `jest.setup.ts`
  scrub list. Base URLs from env are kept: that is the operator's own routing.
- **Vision**: construct `SmartAIVisionClient` / the classifier with
  `configFromCredentials(creds, { kind: 'vision' })`. Its existing vendor scoping
  (`credentialsFor`, #74/#245) then has only the tenant's vendor, so even with the org's
  fallback on, no other vendor is contacted.
- **Hosted RPC**: `startServer({ aiCredentials: (principal) => … })` resolves a tenant's
  credentials per request, lazily; a lookup that throws is logged and becomes no AI, so
  its message never reaches the client. Hosted `iris connect` passes `managedAiResolver` (#344, #479).

### Tenant-Scoped Ledger and Vision Cache (issue #255)

- **`CostTracker(dbPath, budget, { orgId, runId })`**: every row it writes carries the
  org and run (`org_id`, `run_id`, added by idempotent ALTER; `(org_id, timestamp)`
  index), and every budget sum, reservation check and `clear()` reads only its org
  (`org_id IS ?`). So one org's spend, or its calls in flight, never trips another
  org's breaker. No org is local mode: the rows with no org, i.e. everything a ledger
  held before, so local behaviour is unchanged.
- **`getStats()` totals are the tracker's run** when it has a `runId` (daily and monthly
  stay org-wide). `SmartAIVisionClient` opens its tracker with a fresh run id, so a
  visual run's `costSummary` no longer reports every run that ever used the ledger.
- **Cache keys carry `org=<id>` first** when an org is set (`generateKey(..., orgId)`),
  so a verdict one org paid for is never served to another. Local keys keep the old
  format, and existing cache entries survive.
- **The org flows from the request**: `SmartClientConfig.orgId` for vision (the hosted
  visual job API #268 sets it), `createResolvedAIClient(config, { orgId })` for text,
  `translate(instruction, context, { orgId })`, and the RPC server passes the
  session's principal. Every org gets the operator's limits; per-plan limits are
  #260/#346, and Postgres `usage_events` stays the billing record (#263).

### Visual Artifact Layout (issue #343)

- **Names come from `artifactName(page, device)`** (src/visual/artifacts.ts): a slug of
  the page and device plus 10 hex characters of a hash of the exact pair. Only
  `[A-Za-z0-9_-]`, at most 100 characters. The hash is what makes names collision-free;
  the old `page.replace('/', '_')` mapped `/a/b` and `/a_b` to one screenshot and one
  baseline.
- **Each run has its own directory**: `<artifactsDir>/runs/<runId>/{current,diff,baseline}/`
  (`artifactsDir` defaults to `.iris`). Run output no longer sits in `.iris/baselines`,
  where `current`/`diff`/`baseline` took the place of a branch name. `runId` (config, or
  `newRunId()`: UTC time plus 8 random hex characters) is returned on the result;
  `runArtifactPath()` refuses a run id or name outside `[A-Za-z0-9_-]`.
- **Baselines use the new name**, but `loadBaseline([newName, legacyName], ref)` still
  finds one saved under `legacyArtifactName()`, so an upgrade does not orphan existing
  baselines. Both names are tried on the branch before main's, so a feature branch's own
  old-name baseline wins over main's new one. The next `--update-baseline` writes the
  new name. Pages that used to collide (`/a/b`, `/a_b`) share the legacy file until
  then: update their baselines after upgrading.
- **The run id is on every surface**: the result, the JSON report (`runId`) and the
  `iris visual` summary line. A caller-supplied `runId` is trusted to be unique; reuse
  writes into the same run directory.
- Runner tests set `artifactsDir` to a temp directory: the runner really creates the
  run directories (only `writeFileSync` is mocked there).

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
  loses its `user:password@`. Errors are cut to 500 characters. The write is awaited
  before the reply, so a reply means the run is recorded (#269 reads it). A failed write is logged, and the request still succeeds. Local
  (token) connections record nothing.
- **Local: `sqliteHistoryStore(path)`** over the #77 tables. `test_results` has no kind
  column, so a run is recognised by the exact summary shape `summarize()` writes
  (`visual: N comparison(s), M failed`, …); rows `iris run` / `iris watch` write are
  not runs of the store, even when a user's instruction starts with `visual: `. It lists by insertion
  order, because SQLite's `created_at` has one-second resolution.
- Hosted CLI `a11y` / `visual` are not tenant surfaces. Hosted a11y/visual runs arrive
  with the job APIs (#267/#268), which call the same store.

### Browser Session Lifecycle (issue #240)

- **`ActionExecutor.cleanup()` waits for an in-flight launch**, then closes what
  it yields. A cleanup that landed mid-launch used to find no browser yet; if
  page creation then failed, that Chromium ran with nothing to close it.
- **A dead browser is dropped, not reused.** The executor clears it on
  `disconnected`, and the protocol clears a `session.page` that `isClosed()`,
  so the next action relaunches. Playwright notices a kill ~100ms after the
  process is gone; a request in that window gets "browser has been closed".
- **`session.busy` counts in-flight requests.** The sweeper skips a busy session,
  and `lastActivity` is refreshed when a request ends, not only when it starts.
  The sweep runs every `min(5 min, sessionTimeout)`.
- **`cleanupSession` deletes only its own map entry**: a launch may have replaced
  it during the await.
- **`isVisible` returns false only on `TimeoutError`.** Anything else (closed
  page, bad selector) is an error, so `element_absent` cannot pass on a dead page.
- ws `close`/`error` stay outside the `SessionGate` on purpose: the gate would
  make a dead client's browser wait for in-flight actions before being reclaimed.
- Chromium `close()` takes 1.4-1.9s on a loaded dev host. Process-exit waits in
  tests get a long poll budget; an orphan never exits, so it costs no signal.

### A Red Suite May Be the Machine, Not the Diff (issue #142)

Before treating a local test failure as a regression, check whether the host was
busy. Suites that drive a real Chromium miss their deadlines under CPU load, and
the result reads like a logic bug: a different test each run, usually in code the
change never touched. Re-run the failing suite alone on a quiet machine — passes
alone, fails in the full run means host load.

Measured at `53ba416`: **5/5 clean unloaded, 4/8 clean with half the cores
consumed.** `--coverage` is more prone to it, since instrumentation alone can tip
an operation over its deadline.

Do not "fix" it by raising a timeout or reducing Jest concurrency. Both were
measured and rejected: serialising the browser suites gave an identical failure
rate for +65% wall clock, those suites still failed running one at a time (so
concurrent browser count is not the variable), and the protocol suite's 10s
timeout is 20/20 clean idle against a workflow costing 1.6-3.2s. Raising a limit
deletes the signal rather than the problem.

Separately: a negative elapsed time in output is the WSL2 clock stepping
backward, not contention. It is why no assertion here is written against a
`Date.now()` delta — see #190 for the seven that were replaced.

### Test Hermeticity (issue #185)

`jest.setup.ts` is where the suite is insulated from the developer's machine.
Three guards live there, all for the same reason — a test must not behave
differently because of an untracked file or an exported shell variable:

- `IRIS_DB_PATH` -> a per-worker temp DB, so runs never write to `~/.iris/iris.db`
- `IRIS_DATA_DIR` -> a per-worker-pid temp dir, emptied at the start of every test file
  (#241). Not an `afterAll`: a setup file's `afterAll` runs before the test file's own.
  Assigned unconditionally: a reused ledger carries spend between files and trips
  the budget breaker in a test that spent nothing
- `IRIS_CONFIG_PATH` -> `<that dir>/config.json`, which never exists, so the developer's
  real `~/.iris/config.json` (budgets, provider) never reaches a test. `config.test.ts`
  unsets it to test the default location
- `IRIS_MODEL_PROBE=0` -> no provider model-list lookups (#184)
- `IRIS_DOTENV_DIR` -> a per-worker temp directory, created 0700 and swept of any stray
  `.env`, so `loadDotenv()` finds nothing (#185). Assigned **unconditionally** — unlike
  the two above, an ambient value here is the hazard, not a preference —
  plus a one-time scrub of `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `OLLAMA_ENDPOINT` /
  `*_MODEL` / `IRIS_BASE_URL` for the shell-export route

`runCli()` calls `loadDotenv()` **during** the test body, so a `beforeEach`
scrub cannot close the `.env` hole — the guard has to stop the read itself. And
it belongs in `jest.setup.ts`, not per file: `visual-cli.test.ts` had a local
`loadDotenv` stub while `cli.test.ts` and `a11y-cli.test.ts` did not, which is
exactly how #185 shipped. The scrub is deliberately once per file, never in a
`beforeEach` — `visual-cli.test.ts` assigns those vars inside test bodies to
exercise provider resolution.

Adding a new variable that IRIS reads from the environment? Add it to the scrub
list too, or the suite silently becomes machine-dependent again.

### Data Directory and Budgets (issue #241)

- `resolveDataDir()` (src/data-dir.ts): `IRIS_DATA_DIR` > `dirname(IRIS_DB_PATH)` >
  `~/.iris`, always absolute. History (`resolveDbPath()`), the cost ledger and the
  vision cache (`<data dir>/cache/`) all use it. The ledger used to be cwd-relative,
  so every directory had its own fresh daily budget.
- The smart client resolves paths and limits **when constructed**, not at import,
  so tests and long-lived processes follow the environment of the moment.
- `resolveBudget()` (src/config.ts): `IRIS_DAILY_BUDGET_USD` / `IRIS_MONTHLY_BUDGET_USD`
  > `budget` in `~/.iris/config.json` > `DEFAULT_BUDGET_LIMITS` ($10 / $200), per field.
  Malformed values throw. An explicit `costConfig` passed to the client still wins.
- Container: compose sets `IRIS_DATA_DIR: /data`, the only durable writable path
  under the read-only root filesystem.
- Under Jest, `process.env.HOME` does not move `os.homedir()` (the env is a copy);
  spy on `os.homedir` instead.

### Configuration Layering (issue #184)

`loadConfig()` merges four layers, most explicit last — it no longer returns
*either* the file config *or* the environment one:

1. built-in defaults (`DEFAULT_MODELS.text[provider]`)
2. environment auto-detection — provider inferred from which `*_API_KEY` / `OLLAMA_ENDPOINT` is exported
3. `~/.iris/config.json`
4. `OPENAI_MODEL` / `ANTHROPIC_MODEL` / `OLLAMA_MODEL`

Consequences worth remembering: a config file no longer disables environment
credentials; an explicit `ai.provider` in the file outranks auto-detection
(presence of a key is a guess, the file is a statement); a `<PROVIDER>_MODEL`
var applies only while that provider is active; and an unparseable config file
degrades to "no file layer" rather than also discarding the environment.

## Project Assessment Process

You will occasionally be asked to assess the current state of the development project. This involves a comprehensive review to understand where the project stands relative to its specifications and development plan.

### Assessment Steps

1. **Codebase Review**: Thoroughly examine all source code in `src/` and related files to understand current implementation state
2. **Test Analysis**: Run `npm run test` and analyze coverage, pass rates, and test quality
3. **Specification Comparison**: Review documentation in `/docs` directory and compare against actual implementation
4. **Development Plan Review**: Examine `plans/README.md` (the single source-of-truth status tracker) to understand what's marked as complete vs. actual state

### Assessment Output

Create a status report in `plans/status_YYYYMMDDHHMM.md` with the following format:

#### Status
**Red/Yellow/Green assessment** based on:
- Codebase quality and completeness
- Test output and coverage
- Alignment with development plan claims

#### Summary
**Bullet points of positive findings:**
- What has been successfully implemented
- Working functionality confirmed by tests
- Progress that aligns with development plan

#### Feedback
**Bullet points of issues and discrepancies:**
- Functionality claimed as complete but not working
- Test failures or inadequate coverage
- Gaps between development plan claims and actual implementation
- Code quality concerns or architectural issues

This assessment provides an objective view of project status and helps identify where development claims may not match reality.

## Quality Standards

Global TDD/coverage/no-mock rules apply. IRIS-specific:

- **Coverage**: >=85% for new code (repo-wide actual: ~93% statements / ~82% branch; new
  code should not lower it). Check with `npm run test -- --coverage`.
- **Pass rate**: 100% of non-skipped tests (current: 2209/2210 passing, 1 skipped, 0
  failing on CI, identical with and without a repo-root `.env`; on WSL the egress-proxy
  "502 when the vetted address refuses" test times out, see #382).
- **Commits**: conventional with scope (`feat(cli):`, `fix(a11y):`); branches
  `feature/…`, `fix/…`, `docs/…`; PR to main, CI green before done.
- **Docs in the same PR**: this file (new patterns/gotchas), `docs/data-flows.md`
  (stores, retention, transmissions), README command examples, JSDoc on public APIs.
  See `AGENT_INSTRUCTIONS.md` for agent guidance.

## Issue Tracking

IRIS tracks active work as **GitHub issues** (via the `gh` CLI). [plans/README.md](plans/README.md) is the canonical "what's next" tracker — if another planning doc disagrees with it, it wins.

### Issue Prioritization Convention (MANDATORY)

**Every new issue MUST be prioritized before it is considered filed.** No issue is left un-triaged.

1. **Title prefix `[PX.Y]`**: every issue title starts with a priority tag, e.g. `[P3.4] Migrate pixelmatch 5.x -> 7.x`.
   - `X` = tier (blast radius / launch impact):
     - **P0** — Launch blocker (`priority-p0`)
     - **P1** — Pre-launch hardening (`priority-p1`)
     - **P2** — Post-launch fast-follow (`priority-p2`)
     - **P3** — Polish / hygiene (`priority-p3`)
   - `Y` = order **within** the tier by importance **and dependency** — lower `Y` = do first / unblocks others. Assign the next free `Y` in the tier, or renumber neighbors if the new issue must come earlier.
2. **Matching label**: add the corresponding `priority-p0..p3` label so tier is filterable (`gh issue list --label priority-p2`).
3. **Placement rule**: slot by both importance and dependency — an issue that blocks others sorts ahead of them within its tier; a working status-quo with no runtime impact sorts to the tail.

To (re)prioritize an existing issue: `gh issue edit <n> --title "[PX.Y] ..." --add-label "priority-pX"`.

### Quick Reference

```bash
# Find work by priority tier
gh issue list --label priority-p1

# Read an issue (context + acceptance criteria) before coding
gh issue view 71

# File discovered work (always with a [PX.Y] prefix + priority label)
gh issue create --title "[P2.9] ..." --label priority-p2 --body "..."
```

### Integration with Development Workflow

1. **Session Start**: Check `plans/README.md` and `gh issue list` for what's next
2. **Before Coding**: Read the issue for context and acceptance criteria
3. **During Implementation**: File discovered issues, prioritized per the convention above
4. **Before Commit**: Verify all acceptance criteria from the issue are met
5. **After Merge**: Issues close via PR closing keywords (`closes #N`); update `plans/README.md` status
