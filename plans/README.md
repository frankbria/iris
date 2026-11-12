# IRIS Plans — Single Source of Truth

This is the **canonical "what's next" tracker** for IRIS. If another planning
doc disagrees with this file, this file wins.

- Active work is tracked as GitHub issues with `[PX.Y]` priority codes
  (**X** = tier, 0 = highest; **Y** = order within tier by importance/dependency).
- Roadmap / future-phase design lives in `docs/` (see _Reference docs_ below).
- Superseded planning artifacts are in `docs/archive/`.

---

## Cycle 4 — SaaS Launch (active)

Generated 2026-09-25 by a multi-agent SaaS launch review (7 areas × 5–8
dimensions, 3-vote adversarial verification), deduplicated into 99
atomic issues (one developer, one session each), all labelled `saas-launch`:
`gh issue list --label saas-launch`.

**Verdict: not ready.** IRIS is a well-tested single-user local tool; launching
it as a hosted product needs hardening of the existing runtime, tighter AI
spend tracking, and a platform layer that does not exist yet (accounts,
tenancy, billing, TLS ingress, production environment, backups,
observability, legal).

**Decisions (2026-09-25):** AI billing is **BYOK + managed-key credits**; the
launch surface is an **authenticated API + minimal portal**. P0.3
([#231](https://github.com/frankbria/iris/issues/231), [ADR 0001](../docs/adr/0001-hosted-architecture.md)) anchors every platform issue.

| Tier | Count |
|------|-------|
| P0 | 51 |
| P1 | 32 |
| P2 | 13 |
| P3 | 7 |

**Order:** working `P0.1 → … → P3.3` has no forward dependencies (validated
before filing). Groups A–E are independent of the platform work in F–K and can
run in parallel with it. Issue numbers are not in code order; the `[PX.Y]`
code is the ordering key.

**Production comes last (2026-10-10).** Every issue closes on local, CI or staging
evidence. A step that can only happen on the production box goes on [#515](https://github.com/frankbria/iris/issues/515)
(P0.61), and the issue it came from closes without it. No issue is marked blocked on
production.

### P0 — Launch blockers


**A. Immediate fixes**

| `[PX.Y]` | Issue | Title | Depends on | Status |
|----------|-------|-------|-----------|--------|
| `P0.1` | [#329](https://github.com/frankbria/iris/issues/329) | Repo hygiene: CI workflow comments and deploy docs | — | DONE ([#366](https://github.com/frankbria/iris/pull/366)) |
| `P0.2` | [#330](https://github.com/frankbria/iris/issues/330) | RPC server: request handling robustness | — | DONE ([#367](https://github.com/frankbria/iris/pull/367)) |
| `P0.3` | [#231](https://github.com/frankbria/iris/issues/231) | ADR: hosted SaaS architecture (BYOK + managed credits, API + portal) | — | DONE ([#368](https://github.com/frankbria/iris/pull/368), [ADR 0001](../docs/adr/0001-hosted-architecture.md)) |

**B. Browser runtime**

| `[PX.Y]` | Issue | Title | Depends on | Status |
|----------|-------|-------|-----------|--------|
| `P0.4` | [#331](https://github.com/frankbria/iris/issues/331) | Browser launch: shared launch factory | P0.3 (#231) | DONE ([#369](https://github.com/frankbria/iris/pull/369)) |
| `P0.5` | [#332](https://github.com/frankbria/iris/issues/332) | Container runtime configuration | P0.4 (#331) | DONE ([#370](https://github.com/frankbria/iris/pull/370); sandbox on staging proven by the post-merge deploy probe) |
| `P0.6` | [#333](https://github.com/frankbria/iris/issues/333) | URL policy: range table update | — | DONE ([#371](https://github.com/frankbria/iris/pull/371)) |
| `P0.7` | [#334](https://github.com/frankbria/iris/issues/334) | Hosted mode: URL policy defaults | P0.3 (#231), P0.6 (#333) | DONE ([#372](https://github.com/frankbria/iris/pull/372)) |
| `P0.8` | [#335](https://github.com/frankbria/iris/issues/335) | Visual and a11y runners: URL policy integration | P0.7 (#334) | DONE ([#373](https://github.com/frankbria/iris/pull/373)) |
| `P0.9` | [#336](https://github.com/frankbria/iris/issues/336) | Hosted browser: network egress layer | P0.4 (#331), P0.6 (#333) | DONE ([#374](https://github.com/frankbria/iris/pull/374)) |
| `P0.10` | [#337](https://github.com/frankbria/iris/issues/337) | URL guard: follow-up items | P0.7 (#334) | DONE ([#377](https://github.com/frankbria/iris/pull/377)) |

**C. RPC server**

| `[PX.Y]` | Issue | Title | Depends on | Status |
|----------|-------|-------|-----------|--------|
| `P0.11` | [#338](https://github.com/frankbria/iris/issues/338) | RPC server: configurable limits | P0.2 (#330) | DONE ([#380](https://github.com/frankbria/iris/pull/380)) |
| `P0.12` | [#240](https://github.com/frankbria/iris/issues/240) | Browser session lifecycle: orphans, crashes, sweeper killing mid-action | P0.2 (#330) | DONE ([#381](https://github.com/frankbria/iris/pull/381)) |

**D. AI spend tracking**

| `[PX.Y]` | Issue | Title | Depends on | Status |
|----------|-------|-------|-----------|--------|
| `P0.13` | [#241](https://github.com/frankbria/iris/issues/241) | One data-dir resolver for history, cost ledger and vision cache; configurable budgets | P0.3 (#231) | DONE ([#384](https://github.com/frankbria/iris/pull/384)) |
| `P0.14` | [#242](https://github.com/frankbria/iris/issues/242) | Meter and budget-gate text/agent LLM calls | P0.13 (#241) | DONE ([#385](https://github.com/frankbria/iris/pull/385)) |
| `P0.15` | [#243](https://github.com/frankbria/iris/issues/243) | Unpriced or rescued model IDs must not record $0 | P0.14 (#242) | DONE ([#387](https://github.com/frankbria/iris/pull/387)) |
| `P0.16` | [#244](https://github.com/frankbria/iris/issues/244) | Record every completed paid call; reserve budget before concurrent calls | P0.14 (#242) | DONE ([#389](https://github.com/frankbria/iris/pull/389)) |
| `P0.17` | [#245](https://github.com/frankbria/iris/issues/245) | Honour the configured AI provider instead of a fixed fallback chain | — | DONE ([#391](https://github.com/frankbria/iris/pull/391)) |

**E. Reports**

| `[PX.Y]` | Issue | Title | Depends on | Status |
|----------|-------|-------|-----------|--------|
| `P0.18` | [#339](https://github.com/frankbria/iris/issues/339) | Reports: output encoding | — | DONE ([#393](https://github.com/frankbria/iris/pull/393)) |

**F. Platform foundations (identity, tenancy, storage)**

| `[PX.Y]` | Issue | Title | Depends on | Status |
|----------|-------|-------|-----------|--------|
| `P0.19` | [#247](https://github.com/frankbria/iris/issues/247) | Monorepo workspaces + scaffold `apps/portal` (Next.js, Nova preset) | P0.3 (#231) | DONE ([#394](https://github.com/frankbria/iris/pull/394)) |
| `P0.20` | [#248](https://github.com/frankbria/iris/issues/248) | PostgreSQL service + migration runner for hosted data | P0.3 (#231), P0.19 (#247) | DONE ([#402](https://github.com/frankbria/iris/pull/402)) |
| `P0.21` | [#249](https://github.com/frankbria/iris/issues/249) | Portal: signup, login and email verification (BetterAuth) | P0.19 (#247), P0.20 (#248) | DONE ([#403](https://github.com/frankbria/iris/pull/403)) |
| `P0.22` | [#250](https://github.com/frankbria/iris/issues/250) | Portal: organizations, membership and roles | P0.21 (#249) | DONE ([#407](https://github.com/frankbria/iris/pull/407)) |
| `P0.23` | [#340](https://github.com/frankbria/iris/issues/340) | Portal: API key management | P0.22 (#250) | DONE ([#411](https://github.com/frankbria/iris/pull/411)) |
| `P0.24` | [#341](https://github.com/frankbria/iris/issues/341) | Server: per-tenant API key authentication | P0.11 (#338), P0.23 (#340) | DONE ([#414](https://github.com/frankbria/iris/pull/414)) |
| `P0.25` | [#342](https://github.com/frankbria/iris/issues/342) | Server: per-key rate limits and session caps | P0.24 (#341) | DONE ([#416](https://github.com/frankbria/iris/pull/416)) |
| `P0.26` | [#254](https://github.com/frankbria/iris/issues/254) | Tenant-scoped history store (storage seam: SQLite local, Postgres hosted) | P0.13 (#241), P0.20 (#248) | DONE ([#419](https://github.com/frankbria/iris/pull/419)) |
| `P0.27` | [#255](https://github.com/frankbria/iris/issues/255) | Tenant-scoped cost ledger and vision cache | P0.16 (#244), P0.26 (#254) | DONE ([#422](https://github.com/frankbria/iris/pull/422)) |
| `P0.28` | [#343](https://github.com/frankbria/iris/issues/343) | Visual artifacts: naming and per-run layout | — | DONE ([#424](https://github.com/frankbria/iris/pull/424)) |
| `P0.29` | [#257](https://github.com/frankbria/iris/issues/257) | Object storage for artifacts with tenant/run prefixes and signed URLs | P0.26 (#254), P0.28 (#343) | DONE (PR #467; SeaweedFS replaces MinIO, owner decision 2026-10-03) |

**G. BYOK**

| `[PX.Y]` | Issue | Title | Depends on | Status |
|----------|-------|-------|-----------|--------|
| `P0.30` | [#258](https://github.com/frankbria/iris/issues/258) | Per-request AI credentials seam (translator + vision client) | P0.14 (#242) | DONE ([#427](https://github.com/frankbria/iris/pull/427)) |
| `P0.31` | [#344](https://github.com/frankbria/iris/issues/344) | BYOK: per-org provider key storage | P0.23 (#340), P0.30 (#258) | DONE ([#430](https://github.com/frankbria/iris/pull/430)) |

**H. Managed-key credits & billing**

| `[PX.Y]` | Issue | Title | Depends on | Status |
|----------|-------|-------|-----------|--------|
| `P0.32` | [#260](https://github.com/frankbria/iris/issues/260) | Plan catalog and org entitlements | P0.20 (#248) | DONE (PR #468; owner-approved limits, one free org per user) |
| `P0.33` | [#261](https://github.com/frankbria/iris/issues/261) | Stripe customer and subscription lifecycle | P0.22 (#250), P0.32 (#260) | DONE (PR #636, with #345): subscribe, upgrade (Pro to Team in the Customer Portal) and cancel were run against Stripe test mode on 2026-11-12, through `stripe listen` and a hosted `iris connect` |
| `P0.34` | [#345](https://github.com/frankbria/iris/issues/345) | Stripe webhook endpoint | P0.33 (#261) | DONE (PR #636, with #261) |
| `P0.35` | [#263](https://github.com/frankbria/iris/issues/263) | Billable usage ledger: browser-minutes, text calls, vision calls, agent turns | P0.27 (#255) | DONE ([#432](https://github.com/frankbria/iris/pull/432)) |
| `P0.36` | [#264](https://github.com/frankbria/iris/issues/264) | Report managed-credit usage to Stripe meters | P0.34 (#345), P0.35 (#263) | DONE (PR #637): run against the Stripe test-mode meter on 2026-11-12; each managed row arrived once (a forced resend counted once) and the reconciliation matched |
| `P0.37` | [#346](https://github.com/frankbria/iris/issues/346) | Entitlement enforcement at the API boundary | P0.25 (#342), P0.32 (#260), P0.35 (#263) | DONE (PR #480; managed credits split to #479) |
| `P0.38` | [#266](https://github.com/frankbria/iris/issues/266) | Payment failure: grace period, suspension and restore | P0.34 (#345), P0.37 (#346) | DONE (PR #638): past_due, grace, suspension and restore run against Stripe test mode with a test clock on 2026-11-12; production uses the default 7 days until #639 |

**I. Hosted features + portal**

| `[PX.Y]` | Issue | Title | Depends on | Status |
|----------|-------|-------|-----------|--------|
| `P0.39` | [#267](https://github.com/frankbria/iris/issues/267) | Hosted a11y job API | P0.8 (#335), P0.24 (#341), P0.26 (#254) | DONE (PR #434) |
| `P0.40` | [#268](https://github.com/frankbria/iris/issues/268) | Hosted visual-diff job API with project baselines and approval | P0.29 (#257), P0.39 (#267) | DONE (PR #473; per-comparison billing #478) |
| `P0.41` | [#269](https://github.com/frankbria/iris/issues/269) | Results retrieval API: runs, run detail, artifact URLs | P0.26 (#254), P0.29 (#257) | DONE (PR #461; artifact URLs split to #460) |
| `P0.42` | [#270](https://github.com/frankbria/iris/issues/270) | Portal: runs and results pages | P0.41 (#269) | DONE (PR #464; visual diffs + approval split to #463) |
| `P0.43` | [#271](https://github.com/frankbria/iris/issues/271) | Portal: usage and billing page | P0.33 (#261), P0.35 (#263) | DONE (PR #640): the Customer Portal redirect from `/usage` run against Stripe test mode on 2026-11-12 |

**J. Ops**

| `[PX.Y]` | Issue | Title | Depends on | Status |
|----------|-------|-------|-----------|--------|
| `P0.44` | [#347](https://github.com/frankbria/iris/issues/347) | TLS ingress and reverse proxy | P0.24 (#341) | DONE (PR #437) |
| `P0.45` | [#273](https://github.com/frankbria/iris/issues/273) | Production environment and deploy pipeline | P0.20 (#248), P0.44 (#347) | DONE (PR #439) |
| `P0.46` | [#274](https://github.com/frankbria/iris/issues/274) | Backups and restore drill for Postgres and object storage | P0.45 (#273) | DONE (PR #446; bucket half split to #445) |
| `P0.47` | [#275](https://github.com/frankbria/iris/issues/275) | Observability: structured logs, metrics, alerting | P0.45 (#273) | DONE (PR #448) |
| `P0.59` | [#440](https://github.com/frankbria/iris/issues/440) | Move staging onto the hosted stack so staged-<sha> proves what production runs | P0.45 (#273) | TODO (raised from P1.38, 2026-10-10: unblocks #514, #445, #376, #316) |
| `P0.60` | [#514](https://github.com/frankbria/iris/issues/514) | Wire object storage and the managed AI key into the hosted deploy, on staging first | P0.59 (#440) | TODO |
| `P0.61` | [#515](https://github.com/frankbria/iris/issues/515) | Production first-deploy checklist: every step that needs the production box | every other open P0 and P1 | BLOCKED (needs-operator, needs-owner; last by design) |

**K. Legal, trust & data lifecycle**

| `[PX.Y]` | Issue | Title | Depends on | Status |
|----------|-------|-------|-----------|--------|
| `P0.48` | [#276](https://github.com/frankbria/iris/issues/276) | Terms of Service and Acceptable Use Policy with recorded acceptance | P0.21 (#249) | DONE (PR #451; wording approval in #450) |
| `P0.49` | [#277](https://github.com/frankbria/iris/issues/277) | Privacy policy, subprocessor list and DPA | P0.19 (#247) | DONE (PR #453; wording approval in #450) |
| `P0.50` | [#348](https://github.com/frankbria/iris/issues/348) | Abuse handling and security contact | P0.24 (#341) | DONE (PR #455) |
| `P0.51` | [#349](https://github.com/frankbria/iris/issues/349) | Account deletion, org offboarding and data retention | P0.26 (#254), P0.29 (#257) | DONE (PR #470) |
| `P0.52` | [#435](https://github.com/frankbria/iris/issues/435) | Reap jobs stuck in running after a worker crash | P0.39 (#267) | DONE (PR #443) |
| `P0.53` | [#445](https://github.com/frankbria/iris/issues/445) | Object storage backups: bucket versioning/replication and a restore drill | P0.60 (#514) | BLOCKED (on #514; closes on a staging bucket) |
| `P0.54` | [#450](https://github.com/frankbria/iris/issues/450) | Owner/counsel approval of the ToS and AUP wording | P0.48 (#276) | BLOCKED (needs-owner): wording approved 2026-11-10, only the placeholder values remain |
| `P0.55` | [#460](https://github.com/frankbria/iris/issues/460) | Signed artifact URLs in run detail | P0.29 (#257) | DONE (PR #471) |
| `P0.56` | [#463](https://github.com/frankbria/iris/issues/463) | Portal: visual diff images and baseline approval | P0.40 (#268), P0.55 (#460) | DONE (PR #474) |
| `P0.57` | [#472](https://github.com/frankbria/iris/issues/472) | Purge visual artifacts from object storage | P0.40 (#268) | DONE (PR #477) |
| `P0.58` | [#479](https://github.com/frankbria/iris/issues/479) | Managed AI credits: org AI mode, IRIS vendor key, credit balance | P0.37 (#346) | DONE (#483) |

### P1 — Pre-launch hardening

| `[PX.Y]` | Issue | Title | Depends on | Status |
|----------|-------|-------|-----------|--------|
| `P1.1` | [#280](https://github.com/frankbria/iris/issues/280) | Visual severity treats a pixel count as a fraction | — | DONE (PR #466) |
| `P1.2` | [#281](https://github.com/frankbria/iris/issues/281) | Failed AI analysis must not downgrade a regression to pass | P1.1 (#280) | DONE (#485) |
| `P1.3` | [#282](https://github.com/frankbria/iris/issues/282) | Diff full-page captures whose height changed; bound decoded image size | — | DONE (#486) |
| `P1.4` | [#283](https://github.com/frankbria/iris/issues/283) | Diff engine: fix pixelmatch option mapping and random early exit | — | DONE (#487) |
| `P1.5` | [#284](https://github.com/frankbria/iris/issues/284) | Visual report and runner: broken image links, dropped errors, mangled URLs | P0.28 (#343) | DONE (#488) |
| `P1.6` | [#285](https://github.com/frankbria/iris/issues/285) | Keyboard tester: invalid selectors and crash on SVG links | — | DONE (#489) |
| `P1.7` | [#286](https://github.com/frankbria/iris/issues/286) | Keyboard tester verdicts: focus order, roving tabindex, Escape | P1.6 (#285) | DONE (#492) |
| `P1.8` | [#287](https://github.com/frankbria/iris/issues/287) | a11y runner: per-page error isolation and report directory creation | — | DONE (#490) |
| `P1.9` | [#288](https://github.com/frankbria/iris/issues/288) | a11y reports, JUnit and history agree with the CLI verdict | P1.8 (#287) | DONE (#494) |
| `P1.10` | [#289](https://github.com/frankbria/iris/issues/289) | a11y CLI flags: validate --fail-on, allow disabling keyboard, fix --pages parsing | — | DONE (#495) |
| `P1.11` | [#290](https://github.com/frankbria/iris/issues/290) | WCAG AA level must include WCAG 2.1/2.2 AA rules | — | DONE (#497) |
| `P1.12` | [#350](https://github.com/frankbria/iris/issues/350) | a11y: axe execution context | — | DONE (#501) |
| `P1.13` | [#351](https://github.com/frankbria/iris/issues/351) | Agent loop: verdict evaluation | — | DONE (#503) |
| `P1.14` | [#293](https://github.com/frankbria/iris/issues/293) | Agent loop error surfacing: provider failure and page-controlled hangs | — | DONE (#507) |
| `P1.15` | [#294](https://github.com/frankbria/iris/issues/294) | `iris run` exits non-zero on failure | — | DONE (#509) |
| `P1.16` | [#352](https://github.com/frankbria/iris/issues/352) | Typed values: credential references | — | DONE (#512) |
| `P1.17` | [#296](https://github.com/frankbria/iris/issues/296) | Do not auto-retry non-idempotent clicks and fills | — | DONE (#516) |
| `P1.18` | [#297](https://github.com/frankbria/iris/issues/297) | Pattern translator: stop turning prose into CSS selectors | — | DONE (#517) |
| `P1.19` | [#298](https://github.com/frankbria/iris/issues/298) | Vision provider detection and Ollama timeouts | — | DONE (#521) |
| `P1.20` | [#299](https://github.com/frankbria/iris/issues/299) | AI cache and ledger hygiene: memory-tier TTL, index name collision | — | DONE (#524) |
| `P1.21` | [#353](https://github.com/frankbria/iris/issues/353) | Agent policy: action validation | — | DONE (#525) |
| `P1.22` | [#354](https://github.com/frankbria/iris/issues/354) | Agent policy: apply flags on every execution path | P0.7 (#334), P1.21 (#353) | DONE (#533) |
| `P1.23` | [#355](https://github.com/frankbria/iris/issues/355) | Vision prompts: content framing | — | DONE (#526) |
| `P1.24` | [#356](https://github.com/frankbria/iris/issues/356) | Local history store improvements | — | DONE (#527) |
| `P1.25` | [#357](https://github.com/frankbria/iris/issues/357) | RPC server: JSON-RPC compliance and error responses | P0.2 (#330) | DONE (#529) |
| `P1.26` | [#358](https://github.com/frankbria/iris/issues/358) | `iris connect`: startup configuration | P0.3 (#231) | DONE (#531) |
| `P1.27` | [#306](https://github.com/frankbria/iris/issues/306) | Build and smoke-test the container on every PR; tie base image to Playwright | — | DONE (#532) |
| `P1.28` | [#359](https://github.com/frankbria/iris/issues/359) | CI/CD: action pinning and deploy configuration | P0.1 (#329) | DONE (#536) |
| `P1.29` | [#360](https://github.com/frankbria/iris/issues/360) | Container image: pinning, scanning, SBOM, notices | P1.27 (#306) | DONE (#537) |
| `P1.30` | [#309](https://github.com/frankbria/iris/issues/309) | Graceful shutdown: drain in-flight work, readiness signal, MCP shutdown | P0.12 (#240) | DONE (#538) |
| `P1.31` | [#361](https://github.com/frankbria/iris/issues/361) | Audit log of tenant actions | P0.26 (#254) | DONE (#539) |
| `P1.32` | [#311](https://github.com/frankbria/iris/issues/311) | Docs truth pass for the hosted product | P0.3 (#231), P0.45 (#273) | DONE (#547) |
| `P1.33` | [#375](https://github.com/frankbria/iris/issues/375) | Hosted egress: prove WebTransport and QUIC cannot bypass the proxy | P0.9 (#336) | DONE (#540) |
| `P1.34` | [#376](https://github.com/frankbria/iris/issues/376) | Container egress firewall for the hosted deployment | P0.9 (#336), P1.33 (#375), P0.59 (#440) | TODO |
| `P1.35` | [#379](https://github.com/frankbria/iris/issues/379) | Egress proxy timeouts, configurable popup cap, per-session page cap | P0.11 (#338) | DONE (#542) |
| `P1.36` | [#408](https://github.com/frankbria/iris/issues/408) | Portal: remove members, change roles, leave an org | P0.22 (#250) | DONE (#543) |
| `P1.39` | [#442](https://github.com/frankbria/iris/issues/442) | Job-level deadline: a hung browser holds the worker forever | P0.52 (#435) | DONE (#545) |
| `P1.43` | [#658](https://github.com/frankbria/iris/issues/658) | Credential-stripping patterns take quadratic time on long input: one request can block the hosted RPC server | P3.34 (#645) | DONE: the userinfo and query-parameter patterns are linear with the same match set; error text is cut to 16,384 units before the patterns; selectors and assertion targets are bounded at 4,096 characters |
| `P1.44` | [#688](https://github.com/frankbria/iris/issues/688) | Billing: guard against a second subscription before Checkout | P0.33 (#261) | DONE (PR #689): run against Stripe test mode on 2026-11-12 (a subscribed org sent to the Customer Portal, an older open session expired, two concurrent requests leave one open session) |

### P2 — Post-launch fast-follow

| `[PX.Y]` | Issue | Title | Depends on | Status |
|----------|-------|-------|-----------|--------|
| `P2.1` | [#312](https://github.com/frankbria/iris/issues/312) | RPC observation method: screenshots and page snapshots ("eyes") | P0.24 (#341) | DONE (#548) |
| `P2.2` | [#362](https://github.com/frankbria/iris/issues/362) | MCP tool: follow-up items | P0.7 (#334) | DONE (#643) |
| `P2.3` | [#314](https://github.com/frankbria/iris/issues/314) | Hosted MCP over HTTP with tenant auth and metering | P0.24 (#341), P0.35 (#263), P2.2 (#362) | DONE (#647) |
| `P2.4` | [#315](https://github.com/frankbria/iris/issues/315) | Per-plan artifact storage quota | P0.29 (#257), P0.37 (#346) | DONE (#551) |
| `P2.5` | [#316](https://github.com/frankbria/iris/issues/316) | Zero-downtime deploys | P0.45 (#273), P1.30 (#309), P0.59 (#440) | TODO |
| `P2.6` | [#317](https://github.com/frankbria/iris/issues/317) | Public status page | P0.47 (#275), P0.59 (#440) | BLOCKED (needs-owner: where the page is hosted) |
| `P2.7` | [#318](https://github.com/frankbria/iris/issues/318) | Store money as integer micro-units | P0.35 (#263) | DONE (#552) |
| `P2.8` | [#319](https://github.com/frankbria/iris/issues/319) | Watcher: `--execute` targets and nested ignore globs | — | DONE (#553) |
| `P2.9` | [#320](https://github.com/frankbria/iris/issues/320) | npm package publish-readiness | — | DONE (#554) |
| `P2.10` | [#321](https://github.com/frankbria/iris/issues/321) | Local SQLite: real migration runner or delete dead migrations | P0.20 (#248) | DONE (#555) |
| `P2.11` | [#322](https://github.com/frankbria/iris/issues/322) | Accessibility of IRIS own reports | P0.18 (#339) | DONE (#556) |
| `P2.12` | [#323](https://github.com/frankbria/iris/issues/323) | Capture engine: do not force `transform: none` on every element | — | DONE (#557) |
| `P2.13` | [#363](https://github.com/frankbria/iris/issues/363) | Dependency audit gate | — | DONE (#649) |
| `P2.14` | [#378](https://github.com/frankbria/iris/issues/378) | Agent mode: per-origin asset allowlist under a pinned origin | — | DONE (#558) |
| `P2.15` | [#412](https://github.com/frankbria/iris/issues/412) | Portal: rename and disable API keys | P0.23 (#340) | DONE (#559) |
| `P2.19` | [#457](https://github.com/frankbria/iris/issues/457) | Account-level bans (user suspension) | P1 (#348) | DONE (#560) |
| `P2.20` | [#475](https://github.com/frankbria/iris/issues/475) | Collect superseded visual baseline images | P1 (#472) | DONE (#561) |
| `P2.22` | [#482](https://github.com/frankbria/iris/issues/482) | Reserve managed AI credit before the call, in Postgres | P1 (#479) | DONE (#567) |
| `P2.21` | [#476](https://github.com/frankbria/iris/issues/476) | Re-sweep a purged org's object prefix after in-flight jobs | P1 (#472) | DONE (#563) |
| `P2.23` | [#491](https://github.com/frankbria/iris/issues/491) | Keyboard tester: judge Escape on the dialog under test | P1 (#286) | DONE (#566) |
| `P2.24` | [#498](https://github.com/frankbria/iris/issues/498) | Hosted a11y results: needs-review count per page | P1 (#290) | DONE (#562) |
| `P2.25` | [#504](https://github.com/frankbria/iris/issues/504) | Assertions that pass before the page settles (element_absent, url_matches) | — | DONE (#568) |
| `P2.27` | [#520](https://github.com/frankbria/iris/issues/520) | OpenAI o-series: omit temperature | — | DONE (#572) |
| `P2.28` | [#522](https://github.com/frankbria/iris/issues/522) | fetchWithTimeout covers the response body | — | DONE (#574) |
| `P2.29` | [#523](https://github.com/frankbria/iris/issues/523) | Cost tracker: price the current models, discontinue the deprecated ones | P1 (#298) | DONE (#650) |
| `P2.30` | [#528](https://github.com/frankbria/iris/issues/528) | RPC server: JSON-RPC batch requests (decided: not supported) | — | DONE (#575) |
| `P2.31` | [#541](https://github.com/frankbria/iris/issues/541) | Audit log: a read surface for org admins, and a retention period (90 days) | P1 (#361) | DONE (#577, #653) |
| `P2.32` | [#639](https://github.com/frankbria/iris/issues/639) | Deploy job: pass IRIS_BILLING_GRACE_DAYS to settings.env so the payment grace period is configurable in production | P0.38 (#266) | BLOCKED (needs-owner) |
| `P2.33` | [#651](https://github.com/frankbria/iris/issues/651) | Live-check the gpt-6 request shape with a real OpenAI key, and confirm the model decisions of #650 | P2.29 (#523) | BLOCKED (needs-owner) |
| `P2.34` | [#654](https://github.com/frankbria/iris/issues/654) | Privacy policy: say how long audit log entries are kept (90 days, #541) | P2.31 (#541) | BLOCKED (needs-owner) |
| `P2.26` | [#513](https://github.com/frankbria/iris/issues/513) | Credential references hardening: origin binding and transformed values | P1.16 (#352) | DONE (#571) |

### P3 — Polish / test trust / hygiene

| `[PX.Y]` | Issue | Title | Depends on | Status |
|----------|-------|-------|-----------|--------|
| `P3.1` | [#325](https://github.com/frankbria/iris/issues/325) | Test trust: AI client fakes must return usage; cover the persistent cache | P0.16 (#244) | DONE (#578) |
| `P3.2` | [#364](https://github.com/frankbria/iris/issues/364) | Test suite: protocol test configuration | P0.24 (#341) | DONE (#579, #584) |
| `P3.3` | [#365](https://github.com/frankbria/iris/issues/365) | Hygiene: comments and dead code in RPC and AI layers | — | DONE (#580) |
| `P3.4` | [#382](https://github.com/frankbria/iris/issues/382) | egress-proxy test assumes 127.0.0.1:1 refuses; it blackholes on WSL | — | DONE (#582) |
| `P3.5` | [#383](https://github.com/frankbria/iris/issues/383) | ActionExecutor.createPage is not reentrant: concurrent calls can orphan a browser | P0.12 (#240) | DONE (#583) |
| `P3.6` | [#386](https://github.com/frankbria/iris/issues/386) | Deprecated createAIClient / AIClientFactory.create(…, 'text') return unmetered text clients | P0.14 (#242) | DONE (#585) |
| `P3.7` | [#388](https://github.com/frankbria/iris/issues/388) | Cost tracker pricing edges left by #243: ceiling above the table, flat-only parents, getPricing | P0.15 (#243) | DONE (#587) |
| `P3.8` | [#390](https://github.com/frankbria/iris/issues/390) | Cost ledger follow-ups from #244: stale reservations, typed budget error, settle/close race | P0.16 (#244) | DONE (#588) |
| `P3.9` | [#409](https://github.com/frankbria/iris/issues/409) | Portal org UX follow-ups from #250 | P0.22 (#250) | DONE (#589) |
| `P3.10` | [#420](https://github.com/frankbria/iris/issues/420) | Strip ANSI escape codes from errors stored in run history | — | DONE (#590) |
| `P3.11` | [#425](https://github.com/frankbria/iris/issues/425) | Retention for local visual run artifacts (.iris/runs) | — | DONE (#591) |
| `P3.13` | [#484](https://github.com/frankbria/iris/issues/484) | Visual reports: run-level 'AI unavailable' count, and count model-config failures | P1.2 (#281) | DONE (#592) |
| `P3.14` | [#496](https://github.com/frankbria/iris/issues/496) | CLI usage errors exit 1 or 2 depending on where they are caught | — | DONE (#593) |
| `P3.15` | [#500](https://github.com/frankbria/iris/issues/500) | iris a11y: reject --tags values axe does not know | — | DONE (#594) |
| `P3.16` | [#502](https://github.com/frankbria/iris/issues/502) | api-runs and hosted-visual-job tests leak an S3 bucket per run | — | DONE (#596) |
| `P3.17` | [#508](https://github.com/frankbria/iris/issues/508) | a11y: close a timed-out page's context at once instead of at run end | — | DONE (#597) |
| `P3.18` | [#510](https://github.com/frankbria/iris/issues/510) | iris run: a distinct exit code for a provider outage, in one-shot and --agent mode | — | DONE (#598) |
| `P3.19` | [#511](https://github.com/frankbria/iris/issues/511) | iris watch: report a provider outage as a failure with its reason | — | DONE (#599) |
| `P3.22` | [#564](https://github.com/frankbria/iris/issues/564) | worker-cli heartbeat test counts wall-clock beats: flaky on a loaded runner | — | DONE (#602) |
| `P3.23` | [#565](https://github.com/frankbria/iris/issues/565) | GLM review job passes when its model call errors: PRs get a 1-second non-review | — | CLOSED: fixed upstream (frankbria/glm-review#15 to #17); the notice and real reviews verified 2026-11-11, the provider-side cause on the owner's word |
| `P3.21` | [#519](https://github.com/frankbria/iris/issues/519) | Pattern translator: reject prose with a selector token glued in | — | DONE (#600) |
| `P3.25` | [#570](https://github.com/frankbria/iris/issues/570) | backup.sh: a container that stops between discovery and exec fails with Docker's message | — | DONE (#605) |
| `P3.26` | [#573](https://github.com/frankbria/iris/issues/573) | AI client request builders are CC 16: split translateInstruction / analyzeVisualDiff | — | DONE (#606) |
| `P3.27` | [#581](https://github.com/frankbria/iris/issues/581) | vision cache auto-prune test: a 10 ms TTL lets the fresh entry expire on a slow host | — | DONE (#601) |
| `P3.28` | [#586](https://github.com/frankbria/iris/issues/586) | text-metering: Ollama test hangs intermittently | — | CLOSED: load-driven, not a defect (#142) |
| `P3.29` | [#595](https://github.com/frankbria/iris/issues/595) | keyboard-real-behavior: trap-check hook times out on CI | — | DONE (#604) |
| `P3.30` | [#603](https://github.com/frankbria/iris/issues/603) | iris run: a malformed budget variable exits 3 instead of a config error | P3.18 (#510) | DONE (#607) |
| `P3.20` | [#518](https://github.com/frankbria/iris/issues/518) | CRAP tech debt: changed functions over the ceiling | — | DONE (#608, #610) |
| `P3.31` | [#609](https://github.com/frankbria/iris/issues/609) | Lizard misreads src/watcher.ts, so changed lines there fail the CRAP gate | P3.20 (#518) | DONE (#611) |
| `P3.32` | [#641](https://github.com/frankbria/iris/issues/641) | Portal: credit left ignores held managed-AI reservations, so it can show credit the resolver refuses | P0.43 (#271) | TODO |
| `P3.33` | [#644](https://github.com/frankbria/iris/issues/644) | CI review job fails at "Fetch the PR diff" when the diff holds a raw ESC byte | — | TODO |
| `P3.34` | [#645](https://github.com/frankbria/iris/issues/645) | stripUserinfo and redactString leave part of a password that contains an @ or a space | — | DONE: both cut to the authority's last `@`; a URL held whole is parsed (`urlWithoutUserinfo`, `stripUserinfo(text, quotedUrl)`); a raw space in free text stays a documented limit |
| `P3.35` | [#646](https://github.com/frankbria/iris/issues/646) | MCP tool: offer the keyboard checks, and decide what `passed` means against `--fail-on` | P2.2 (#362) | BLOCKED (needs-owner) |
| `P3.36` | [#648](https://github.com/frankbria/iris/issues/648) | Hosted MCP: report where a redirect landed, and axe's help URL for each violated rule | P2.3 (#314) | DONE: a redirected page's result stores `landedUrl` (origin and path, cut); the tool reports it as `url` with `redirected` and `redirectedFrom`; each rule's `helpUrl` is derived from the installed axe version, not stored |
| `P3.37` | [#652](https://github.com/frankbria/iris/issues/652) | Price table: delete deprecated rows after their shutdown dates; sampling options for fine-tuned ids | P2.29 (#523) | PARTIAL: fine-tuned sampling and the visual-diff reason are done; the price rows wait for their dates (first 2026-11-30), the reply cap for #651 |
| `P3.38` | [#660](https://github.com/frankbria/iris/issues/660) | redactString: a run of bare separators costs a callback each (1 MB of & takes about 360 ms) | P1.43 (#658) | DONE: the pattern needs a value again and a `?` begins a match only as the first of its name; 1 MB of separators about 9 ms, match set unchanged |
| `P3.39` | [#662](https://github.com/frankbria/iris/issues/662) | a11y: a client-side navigation is not reported as a redirect; portal run detail does not show landedUrl | P3.36 (#648) | DONE: the runner reports the document's URL at the time axe runs (`guardedDocumentUrl`), a refused or failed move fails the scan, and run detail shows `(landed on …)` |
| `P3.40` | [#664](https://github.com/frankbria/iris/issues/664) | Fine-tuned OpenAI ids: the vision table refuses them and the price table charges the dearest rate | P3.37 (#652) | DONE (#670): four fine-tuned rows from OpenAI's pricing page (they go with their bases on 2027-01-14); a fine-tuned id is never a vision model and the refusal says so |
| `P3.41` | [#666](https://github.com/frankbria/iris/issues/666) | Tests: freePort() releases the port before iris connect listens, so a parallel suite can take it (address already in use) | — | DONE: `iris connect` is spawned on port 0 and its port read back; nginx, the portal image and `--metrics-port` are started again on fresh ports when they report theirs taken (`__tests__/utils/ports.ts`) |
| `P3.42` | [#668](https://github.com/frankbria/iris/issues/668) | URL guard: record only main-frame refusals, so a refused move's reason cannot be a frame's | P3.39 (#662) | DONE: the page session records a refused document only for the main frame (its frame id is the page's target id), so a refused iframe is not quoted when the main document fails for another reason |
| `P3.43` | [#669](https://github.com/frankbria/iris/issues/669) | a11y: a page that moves on after the network went idle is reported at its first page, or fails mid-scan | P3.39 (#662) | DONE: every check is held to the document read before it; a page whose origin or path changes under one fails with "The page navigated during the scan" (a query-only or fragment-only change does not); the keyboard checks run last, and a move one of their own key presses made is not an error |
| `P3.44` | [#673](https://github.com/frankbria/iris/issues/673) | URL guard: a main frame's earlier refusal is quoted for a later move that failed for another reason | P3.42 (#668) | DONE: the guard remembers which navigation a refused main-frame document belonged to and, when the main frame commits, keeps that refusal as the error page's reason only if the commit is that navigation's; `guardedDocumentUrl` quotes that. Follow-up: #677 (P3.46) |
| `P3.45` | [#675](https://github.com/frankbria/iris/issues/675) | a11y: a page that reloads itself, or a key other than Escape that navigates, is not told apart during the scan | P3.43 (#669) | DONE: the runner holds the scanned document itself, so a reload (or the same path under another query string) during a check fails the page as "navigated during the scan … and loaded again", while a query or fragment rewrite within the document still does not; an arrow key that leaves the page is the keyboard check's own move and a failed interaction; a handler that navigates after a delay stays the page's move (decision, pinned by a test). Follow-up: none |
| `P3.46` | [#677](https://github.com/frankbria/iris/issues/677) | URL guard: the error page's reason depends on event order, and only the latest refused navigation is remembered | P3.44 (#673) | DONE: `guardedDocumentUrl` is async and asks the browser which navigation left the error page (`Page.getFrameTree` on the guard's session), instead of reading state set from commit events; refused navigations are kept by id, the newest 16. The reason no longer depends on event order, and a refused move a second one overtook keeps its own reason. Follow-up: none |
| `P3.47` | [#679](https://github.com/frankbria/iris/issues/679) | a11y: the keyboard checks' return to the start page can hide a move the page made by itself | P3.45 (#675) | DONE: shown in Chromium (a page that moved by itself to a page with a dialog was taken back to the start URL and reported with the second page's results); the keyboard tester now holds the document it started on and, before its Escape check goes back, stops when the page moved, loaded again or pushed another path with no key of the tester's to blame, so the runner fails the page as "navigated during the scan", with custom sequences configured too. Follow-up: none |
| `P3.48` | [#681](https://github.com/frankbria/iris/issues/681) | URL guard: a popup's refused opening navigation leaves an error page with no reason | P3.46 (#677) | CLOSED, not done on purpose: nothing reads a popup with `guardedDocumentUrl`, so the code to carry an opener-judged refusal over to the popup's guard would serve no caller. The read still fails ("could not be loaded"), only without the policy's reason; pinned by a real-Chromium test and written into `.claude/rules/browser-safety.md`. Reopen when a caller reads popups. Follow-up: none |
| `P3.49` | [#683](https://github.com/frankbria/iris/issues/683) | a11y: the keyboard tester never releases the document it reloaded into, and a move pushed away and back keeps a plain error | P3.47 (#679) | DONE: the a11y runner releases the document the keyboard checks loaded again once its hold has asked it, and the tester releases a leftover one when its next run begins; the tester now throws `NavigatedDuringScanError` itself for a move it saw the page make, so a router that pushed the first path back before the runner's read no longer leaves a plain "Keyboard testing failed" error (shown in Chromium). Follow-up: none |
| `P3.50` | [#685](https://github.com/frankbria/iris/issues/685) | Portal E2E: "a user left in no org is sent to log in again" sometimes gets Next's error page on /dashboard | — | DONE: not test timing. The dashboard's link prefetches found the user in no org and signed the session out while the test's own `/dashboard` request was between two BetterAuth reads, which then threw the session middleware's 401. `requireOrg()` and the reads `/org` and `/api-keys` make after it now send a session that ended meanwhile to `/login` (`logInIfSignedOut`); the test is unchanged. A user can hit it by logging out in a second tab. Follow-up: none |

---

## Cycle 3 — Vision Alignment (active)

Generated 2026-07-23 by the `improve` skill (deep audit: does the architecture
actually deliver the PRD's "eyes and hands for AI coding assistants" vision?).
Verdict: one of five PRD user stories is built end-to-end, and even it was
CLI-unreachable. Every finding below was vetted against the live code at
commit `bdf7b7d` before planning. Plans are self-contained executor handoffs.

| Plan | `[PX.Y]` | Title | Issue | Depends on | Status |
|------|----------|-------|-------|-----------|--------|
| 009 | `P1.6` | Wire AI provider/key into `visual-diff --semantic` (always crashes today) | [#111](https://github.com/frankbria/iris/issues/111) | — | DONE |
| 010 | `P1.7` | `iris run --url` starting page (actions hit about:blank today) | [#112](https://github.com/frankbria/iris/issues/112) | — | DONE |
| 011 | `P1.12` | `iris run --json` + assistant-facing integration doc | [#113](https://github.com/frankbria/iris/issues/113) | — (best after 010) | DONE |
| 012 | `P1.13` | MCP server spike — one real tool, verified in Claude Code | [#114](https://github.com/frankbria/iris/issues/114) | — | DONE |
| 017 | `P2.5` | Canonical-surface decision + README/PRD truth pass | [#115](https://github.com/frankbria/iris/issues/115) | — | DONE |
| 013 | `P2.6` | Assertion vocabulary (`verify/make sure` representable, `goalMet`) | [#116](https://github.com/frankbria/iris/issues/116) | 010 | DONE |
| 014 | `P2.7` | Agentic observe→act loop (`iris run --agent`) | [#117](https://github.com/frankbria/iris/issues/117) → subs [#121](https://github.com/frankbria/iris/issues/121), [#122](https://github.com/frankbria/iris/issues/122) | 010, 013 | DONE |
| 015 | `P2.8` | Watch-mode AI feedback (classify changes on save) | [#118](https://github.com/frankbria/iris/issues/118) | 009 | DONE |
| 016 | `P2.9` | Surface dropped AI intelligence; diff image into vision request | [#119](https://github.com/frankbria/iris/issues/119) → subs [#123](https://github.com/frankbria/iris/issues/123), [#124](https://github.com/frankbria/iris/issues/124) | 009 | DONE (#123, #124) |

**Dependency notes:** 009 unblocks 015/016 (and makes #68 user-relevant);
010 unblocks 013 → 014. 011, 012, 017 are independent. Existing issues #68–71
were renumbered to P1.8–P1.11 and #77/#78 to P2.10/P2.11 to slot this cycle
by importance and dependency.

**Findings considered and NOT planned this cycle:**
- Pattern grammar passes prose verbatim as CSS selectors (`"click submit"` →
  `page.click('submit')`; shipped watch default fails on every real page) —
  real, but superseded if 014 lands (agent path) and overlaps selector-retry
  work in #75; revisit if 014 is deferred.
- PRD US1 (autonomous exploration) and US4 (design-system compliance) —
  explicitly deferred as roadmap, handled honestly by plan 017's status
  annotations rather than built.
- Per-region AI classification (feeding `analyzeRegions` output to the model) —
  Phase-2C design work, noted as the natural follow-up to 016.

---

## Cycle 2 — Production Readiness (active)

Generated 2026-06-25 by a multi-agent production-readiness audit (every finding
adversarially verified before filing; stale-coverage false positives and three
debunked "critical" security claims were dropped). Each issue is atomic — one
developer, one session.

| `[PX.Y]` | Issue | Title | Labels | Depends on | Status |
|----------|-------|-------|--------|-----------|--------|
| `P0.1` | [#23](https://github.com/frankbria/iris/issues/23) | `iris a11y` broken by default — HTML/JUnit report formats throw | bug | — | TODO |
| `P1.1` | [#24](https://github.com/frankbria/iris/issues/24) | Make package publish-ready (`files`, `prepublishOnly`, name) | packaging | P3.2 (rec.) | TODO |
| `P1.2` | [#25](https://github.com/frankbria/iris/issues/25) | Visual baseline save failure silently reports `passed:true` | bug | — | TODO |
| `P1.3` | [#26](https://github.com/frankbria/iris/issues/26) | Consolidate plan/ + plans/ + docs/ (residual doc-accuracy cleanup) | docs | — | IN PROGRESS |
| `P2.1` | [#27](https://github.com/frankbria/iris/issues/27) | Configurable base URL for visual-diff and a11y | enhancement | — | TODO |
| `P2.2` | [#28](https://github.com/frankbria/iris/issues/28) | Harden `iris run` DB persistence (close handle, no crash) | bug | — | TODO |
| `P2.3` | [#29](https://github.com/frankbria/iris/issues/29) | AI client timeouts + retry; stop swallowing transient errors | improve | — | TODO |
| `P2.4` | [#30](https://github.com/frankbria/iris/issues/30) | Implement `testImageAltText` (advertised but no-op) | bug | — | TODO |
| `P2.5` | [#31](https://github.com/frankbria/iris/issues/31) | Fix Jest `--coverage` breaking Playwright `page.evaluate()` | tests | — | TODO |
| `P2.6` | [#32](https://github.com/frankbria/iris/issues/32) | Test coverage: watcher `--execute` + a11y CLI glue | tests | P2.5 | TODO |
| `P3.1` | [#33](https://github.com/frankbria/iris/issues/33) | Validate numeric CLI inputs (NaN/range) + instruction cap | improve | — | TODO |
| `P3.2` | [#34](https://github.com/frankbria/iris/issues/34) | Remove/implement dead `index.ts` wrappers that throw | improve | — | TODO |
| `P3.3` | [#35](https://github.com/frankbria/iris/issues/35) | Remove dead migration framework / unify `schema_version` | improve | — | TODO |
| `P3.4` | [#36](https://github.com/frankbria/iris/issues/36) | Bound AI vision cache growth (call `pruneExpired()`) | improve | — | TODO |
| `P3.5` | [#37](https://github.com/frankbria/iris/issues/37) | Low-sev hardening bundle (logs, git-branch warn, shutdown, perms) | improve | — | TODO |

**Recommended order:** `P0.1` → `P1.1`/`P1.2`/`P1.3` → `P2.x` → `P3.x`.
Do `P3.2` before `P1.1` (don't publish a throwing API surface). Do `P2.5`
before `P2.6` (coverage must run cleanly before measuring it).

### Production-readiness verdict (audit summary)

Not yet production-ready, but close, and the gaps are well-bounded. **One
default-path bug blocks a headline feature** (`iris a11y` with default
`--format html` crashes — P0.1). **Publishing is not safe yet** (P1.1: no
`files` field → bloated tarball; no `prepublishOnly` + gitignored `dist/` → a
publish would ship a broken bin). **One correctness bug gives false-green**
(P1.2: failed baseline writes report success). Everything else is robustness,
input-validation, test-trust, and hygiene work. The earlier alarms about "0%
coverage" and several "critical" security holes did **not** survive
verification — actual unit coverage on the core runners is ~85–95%, and the
session-ID / schema-conflict / ws-send "criticals" were debunked.

---

## Cycle 1 — Foundations & Hardening (complete)

Generated 2026-06-21 by the `improve` skill. All plans landed and the issues
are closed; plan files retained in this folder for reference.

| Plan | `[PX.Y]` | Title | Issue | Status |
|------|----------|-------|-------|--------|
| 001 | `P0.1` | Resolve runtime dependency vulnerabilities | [#1](https://github.com/frankbria/iris/issues/1) | DONE |
| 002 | `P1.1` | Enforce concurrency cap (worker pool); fix stale e2e | [#2](https://github.com/frankbria/iris/issues/2) | DONE |
| 003 | `P1.2` | Harden the `iris connect` WebSocket server | [#3](https://github.com/frankbria/iris/issues/3) | DONE |
| 004 | `P1.3` | Fix AccessibilityRunner URL handling; un-skip 21 tests | [#4](https://github.com/frankbria/iris/issues/4) | DONE |
| 005 | `P2.1` | DX quality gates: typecheck/lint/format, CI, .env.example | [#5](https://github.com/frankbria/iris/issues/5) | DONE |
| 006 | `P2.2` | Reconcile docs with reality; archive stale reports | [#6](https://github.com/frankbria/iris/issues/6) | DONE |
| 007 | `P2.3` | Restrict config-file perms; close leaked handles | [#7](https://github.com/frankbria/iris/issues/7) | DONE |
| 008 | `P3.1` | Spike: surface cost/cache infra in `visual-diff` CLI | [#8](https://github.com/frankbria/iris/issues/8) | DONE (PoC behind `--show-cost`) |

Plus follow-ups #10 (dev advisories), #15 (gate hardening), #16 (.env autoload).
See the `00N-*.md` files in this folder and `notes/` for the original plans.

---

## Reference docs (not status — design/roadmap)

- `docs/dev_plan.md`, `docs/prd.md`, `docs/tech_specs.md`, `docs/user_stories.md` — product/spec reference.
- `docs/phase2_technical_architecture.md` — Phase 2 architecture.
- `docs/phase2c_roadmap.md` — **ROADMAP, not started** (parallel execution / perf, future phase).
- `docs/archive/` — superseded reports and stale planning (incl. `phase2_todo.md`, `PHASE2_README.md`).
