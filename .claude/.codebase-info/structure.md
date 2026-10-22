# Project Structure

Moved from CLAUDE.md (2026-10-22) so it loads only on demand.


```
src/
├── cli.ts                  # CLI interface and command routing
├── browser.ts              # The only Chromium launch/context factory: launchBrowser(), newHardenedContext() (#331)
├── actions.ts              # Action vocabulary: what IRIS can be asked to do to a page
├── translator.ts           # Instruction -> actions: patterns first, else AI (translate(), #293/#294)
├── executor.ts             # ActionExecutor: runs actions, retry rules (#296), credential refs (#352)
├── agent-loop.ts           # `iris run --agent`: observe, plan, act, check goal (#351)
├── page-timeout.ts         # Bounded page.title/evaluate/addStyleTag for hung pages (#294)
├── protocol.ts             # `iris connect`: WS JSON-RPC server, limits, rate buckets, usage (#330, #338, #342)
├── watcher.ts              # `iris watch`: re-run on file changes (chokidar)
├── data-dir.ts             # resolveDataDir(): history, AI ledger, vision cache location (#241)
├── db.ts                   # Local SQLite schema (history, ledger, cache)
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
├── a11y/                  # a11y-runner, axe-integration (isolated world, #350), keyboard-tester, wcag (#290)
├── byok/                  # crypto.ts envelope encryption, store.ts, rewrap.ts (#344)
├── mcp/                   # MCP stdio server (experimental, spike scope)
│   ├── server.ts          # `iris-mcp` bin — McpServer over StdioServerTransport
│   └── tools.ts           # run_accessibility_test (axe violations + needsReview)
├── auth/config.ts         # createAuth(): the BetterAuth config portal + API share (ADR 0001 §4, #247)
├── legal/                 # versions.ts: current ToS/AUP versions + ACCEPTED_TERMS; acceptance.ts: record/check (#276)
├── api-key-auth.ts        # Hosted `iris connect`: Bearer org API key -> { orgId, keyId } (#341)
├── db/                    # Hosted Postgres (ADR 0001 §2, #248)
│   ├── postgres.ts        # resolveDatabaseUrl() (DATABASE_URL / _FILE), createPostgresDb(): Kysely over pg
│   ├── migrate.ts         # migrateToLatest(); `node dist/db/migrate.js` is the deploy step; no-op on a newer schema (#273)
│   └── migrations/        # NNNN_<what>.ts, registered in migrate.ts's MIGRATIONS map (0002: run history, #254; 0003: usage, #263; 0006: terms acceptances, #276; 0007: org suspensions, #348; 0009: org plans, #260; 0010: offboarding, #349; 0011: visual baselines, #268; 0012: artifact purges, #472; 0013: org AI settings, #479; 0014: observation usage, #312; 0016: user bans, #457)
├── agent-policy.ts        # What may the agent DO? (allowlist, origin pin, destructive)
├── credential-refs.ts     # {{secret:NAME}} fill values: sources, resolve at fill time, scrub (#352)
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
├── audit-log.ts           # recordAudit(): tenant audit entries, on the change's own transaction (#361)
├── member-keys.ts         # A departing member's API keys revoked; create-time re-check (#408)
├── visual-baselines.ts    # Project baselines (orgBaselines) and audited approval, no runner imports: API + portal (#268, #463)
├── run-reads.ts           # Read-only run queries (types, keyset cursor, listPage, get): no runner imports, so the portal can use it (#270)
├── history-store.ts       # HistoryStore seam: sqliteHistoryStore (local), postgresHistory(db).forOrg() (hosted, #254)
└── config.ts              # Configuration types and validation

__tests__/
├── cli.test.ts                    # CLI command testing
├── cli-run-exit.test.ts           # Spawned `iris run`: exit 0 / 1 (provider outage, reason in JSON) / 2 (usage) reach the OS (#294)
├── credential-refs.test.ts        # Real Chromium: {{secret:NAME}} typed, kept out of results, fill errors and the agent digest; hosted env off (#352)
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
