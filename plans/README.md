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
([#231](https://github.com/frankbria/iris/issues/231), the hosted-architecture ADR) anchors every platform issue.

| Tier | Count | Issues |
|------|-------|--------|
| P0 | 51 | #229–#279 |
| P1 | 32 | #280–#311 |
| P2 | 13 | #312–#324 |
| P3 | 3 | #325–#327 |

**Order:** working `P0.1 → … → P3.3` has no forward dependencies (validated
before filing). Groups A–E are independent of the platform work in F–K and can
run in parallel with it.

### P0 — Launch blockers


**A. Immediate fixes**

| `[PX.Y]` | Issue | Title | Depends on | Status |
|----------|-------|-------|-----------|--------|
| `P0.1` | [#229](https://github.com/frankbria/iris/issues/229) | Security hardening | — | TODO |
| `P0.2` | [#230](https://github.com/frankbria/iris/issues/230) | Security hardening | — | TODO |
| `P0.3` | [#231](https://github.com/frankbria/iris/issues/231) | ADR: hosted SaaS architecture (BYOK + managed credits, API + portal) | — | TODO |

**B. Browser runtime**

| `[PX.Y]` | Issue | Title | Depends on | Status |
|----------|-------|-------|-----------|--------|
| `P0.4` | [#232](https://github.com/frankbria/iris/issues/232) | Security hardening | P0.3 (#231) | TODO |
| `P0.5` | [#233](https://github.com/frankbria/iris/issues/233) | Security hardening | P0.4 (#232) | TODO |
| `P0.6` | [#234](https://github.com/frankbria/iris/issues/234) | Security hardening | — | TODO |
| `P0.7` | [#235](https://github.com/frankbria/iris/issues/235) | Security hardening | P0.3 (#231), P0.6 (#234) | TODO |
| `P0.8` | [#236](https://github.com/frankbria/iris/issues/236) | Security hardening | P0.7 (#235) | TODO |
| `P0.9` | [#237](https://github.com/frankbria/iris/issues/237) | Security hardening | P0.4 (#232), P0.6 (#234) | TODO |
| `P0.10` | [#238](https://github.com/frankbria/iris/issues/238) | Security hardening | P0.7 (#235) | TODO |

**C. RPC server**

| `[PX.Y]` | Issue | Title | Depends on | Status |
|----------|-------|-------|-----------|--------|
| `P0.11` | [#239](https://github.com/frankbria/iris/issues/239) | Security hardening | P0.2 (#230) | TODO |
| `P0.12` | [#240](https://github.com/frankbria/iris/issues/240) | Browser session lifecycle: orphans, crashes, sweeper killing mid-action | P0.2 (#230) | TODO |

**D. AI spend tracking**

| `[PX.Y]` | Issue | Title | Depends on | Status |
|----------|-------|-------|-----------|--------|
| `P0.13` | [#241](https://github.com/frankbria/iris/issues/241) | One data-dir resolver for history, cost ledger and vision cache; configurable budgets | P0.3 (#231) | TODO |
| `P0.14` | [#242](https://github.com/frankbria/iris/issues/242) | Meter and budget-gate text/agent LLM calls | P0.13 (#241) | TODO |
| `P0.15` | [#243](https://github.com/frankbria/iris/issues/243) | Unpriced or rescued model IDs must not record $0 | P0.14 (#242) | TODO |
| `P0.16` | [#244](https://github.com/frankbria/iris/issues/244) | Record every completed paid call; reserve budget before concurrent calls | P0.14 (#242) | TODO |
| `P0.17` | [#245](https://github.com/frankbria/iris/issues/245) | Honour the configured AI provider instead of a fixed fallback chain | — | TODO |

**E. Reports**

| `[PX.Y]` | Issue | Title | Depends on | Status |
|----------|-------|-------|-----------|--------|
| `P0.18` | [#246](https://github.com/frankbria/iris/issues/246) | Security hardening | — | TODO |

**F. Platform foundations (identity, tenancy, storage)**

| `[PX.Y]` | Issue | Title | Depends on | Status |
|----------|-------|-------|-----------|--------|
| `P0.19` | [#247](https://github.com/frankbria/iris/issues/247) | Monorepo workspaces + scaffold `apps/portal` (Next.js, Nova preset) | P0.3 (#231) | TODO |
| `P0.20` | [#248](https://github.com/frankbria/iris/issues/248) | PostgreSQL service + migration runner for hosted data | P0.3 (#231), P0.19 (#247) | TODO |
| `P0.21` | [#249](https://github.com/frankbria/iris/issues/249) | Portal: signup, login and email verification (BetterAuth) | P0.19 (#247), P0.20 (#248) | TODO |
| `P0.22` | [#250](https://github.com/frankbria/iris/issues/250) | Portal: organizations, membership and roles | P0.21 (#249) | TODO |
| `P0.23` | [#251](https://github.com/frankbria/iris/issues/251) | Security hardening | P0.22 (#250) | TODO |
| `P0.24` | [#252](https://github.com/frankbria/iris/issues/252) | Security hardening | P0.11 (#239), P0.23 (#251) | TODO |
| `P0.25` | [#253](https://github.com/frankbria/iris/issues/253) | Security hardening | P0.24 (#252) | TODO |
| `P0.26` | [#254](https://github.com/frankbria/iris/issues/254) | Tenant-scoped history store (storage seam: SQLite local, Postgres hosted) | P0.13 (#241), P0.20 (#248) | TODO |
| `P0.27` | [#255](https://github.com/frankbria/iris/issues/255) | Tenant-scoped cost ledger and vision cache | P0.16 (#244), P0.26 (#254) | TODO |
| `P0.28` | [#256](https://github.com/frankbria/iris/issues/256) | Security hardening | — | TODO |
| `P0.29` | [#257](https://github.com/frankbria/iris/issues/257) | Object storage for artifacts with tenant/run prefixes and signed URLs | P0.26 (#254), P0.28 (#256) | TODO |

**G. BYOK**

| `[PX.Y]` | Issue | Title | Depends on | Status |
|----------|-------|-------|-----------|--------|
| `P0.30` | [#258](https://github.com/frankbria/iris/issues/258) | Per-request AI credentials seam (translator + vision client) | P0.14 (#242) | TODO |
| `P0.31` | [#259](https://github.com/frankbria/iris/issues/259) | Security hardening | P0.23 (#251), P0.30 (#258) | TODO |

**H. Managed-key credits & billing**

| `[PX.Y]` | Issue | Title | Depends on | Status |
|----------|-------|-------|-----------|--------|
| `P0.32` | [#260](https://github.com/frankbria/iris/issues/260) | Plan catalog and org entitlements | P0.20 (#248) | TODO |
| `P0.33` | [#261](https://github.com/frankbria/iris/issues/261) | Stripe customer and subscription lifecycle | P0.22 (#250), P0.32 (#260) | TODO |
| `P0.34` | [#262](https://github.com/frankbria/iris/issues/262) | Security hardening | P0.33 (#261) | TODO |
| `P0.35` | [#263](https://github.com/frankbria/iris/issues/263) | Billable usage ledger: browser-minutes, text calls, vision calls, agent turns | P0.27 (#255) | TODO |
| `P0.36` | [#264](https://github.com/frankbria/iris/issues/264) | Report managed-credit usage to Stripe meters | P0.34 (#262), P0.35 (#263) | TODO |
| `P0.37` | [#265](https://github.com/frankbria/iris/issues/265) | Security hardening | P0.25 (#253), P0.32 (#260), P0.35 (#263) | TODO |
| `P0.38` | [#266](https://github.com/frankbria/iris/issues/266) | Payment failure: grace period, suspension and restore | P0.34 (#262), P0.37 (#265) | TODO |

**I. Hosted features + portal**

| `[PX.Y]` | Issue | Title | Depends on | Status |
|----------|-------|-------|-----------|--------|
| `P0.39` | [#267](https://github.com/frankbria/iris/issues/267) | Hosted a11y job API | P0.8 (#236), P0.24 (#252), P0.26 (#254) | TODO |
| `P0.40` | [#268](https://github.com/frankbria/iris/issues/268) | Hosted visual-diff job API with project baselines and approval | P0.29 (#257), P0.39 (#267) | TODO |
| `P0.41` | [#269](https://github.com/frankbria/iris/issues/269) | Results retrieval API: runs, run detail, artifact URLs | P0.26 (#254), P0.29 (#257) | TODO |
| `P0.42` | [#270](https://github.com/frankbria/iris/issues/270) | Portal: runs and results pages | P0.41 (#269) | TODO |
| `P0.43` | [#271](https://github.com/frankbria/iris/issues/271) | Portal: usage and billing page | P0.33 (#261), P0.35 (#263) | TODO |

**J. Ops**

| `[PX.Y]` | Issue | Title | Depends on | Status |
|----------|-------|-------|-----------|--------|
| `P0.44` | [#272](https://github.com/frankbria/iris/issues/272) | Security hardening | P0.24 (#252) | TODO |
| `P0.45` | [#273](https://github.com/frankbria/iris/issues/273) | Production environment and deploy pipeline | P0.20 (#248), P0.44 (#272) | TODO |
| `P0.46` | [#274](https://github.com/frankbria/iris/issues/274) | Backups and restore drill for Postgres and object storage | P0.45 (#273) | TODO |
| `P0.47` | [#275](https://github.com/frankbria/iris/issues/275) | Observability: structured logs, metrics, alerting | P0.45 (#273) | TODO |

**K. Legal, trust & data lifecycle**

| `[PX.Y]` | Issue | Title | Depends on | Status |
|----------|-------|-------|-----------|--------|
| `P0.48` | [#276](https://github.com/frankbria/iris/issues/276) | Terms of Service and Acceptable Use Policy with recorded acceptance | P0.21 (#249) | TODO |
| `P0.49` | [#277](https://github.com/frankbria/iris/issues/277) | Privacy policy, subprocessor list and DPA | P0.19 (#247) | TODO |
| `P0.50` | [#278](https://github.com/frankbria/iris/issues/278) | Security hardening | P0.24 (#252) | TODO |
| `P0.51` | [#279](https://github.com/frankbria/iris/issues/279) | Account deletion, org offboarding and data retention | P0.26 (#254), P0.29 (#257) | TODO |

### P1 — Pre-launch hardening

| `[PX.Y]` | Issue | Title | Depends on | Status |
|----------|-------|-------|-----------|--------|
| `P1.1` | [#280](https://github.com/frankbria/iris/issues/280) | Visual severity treats a pixel count as a fraction | — | TODO |
| `P1.2` | [#281](https://github.com/frankbria/iris/issues/281) | Failed AI analysis must not downgrade a regression to pass | P1.1 (#280) | TODO |
| `P1.3` | [#282](https://github.com/frankbria/iris/issues/282) | Diff full-page captures whose height changed; bound decoded image size | — | TODO |
| `P1.4` | [#283](https://github.com/frankbria/iris/issues/283) | Diff engine: fix pixelmatch option mapping and random early exit | — | TODO |
| `P1.5` | [#284](https://github.com/frankbria/iris/issues/284) | Visual report and runner: broken image links, dropped errors, mangled URLs | P0.28 (#256) | TODO |
| `P1.6` | [#285](https://github.com/frankbria/iris/issues/285) | Keyboard tester: invalid selectors and crash on SVG links | — | TODO |
| `P1.7` | [#286](https://github.com/frankbria/iris/issues/286) | Keyboard tester verdicts: focus order, roving tabindex, Escape | P1.6 (#285) | TODO |
| `P1.8` | [#287](https://github.com/frankbria/iris/issues/287) | a11y runner: per-page error isolation and report directory creation | — | TODO |
| `P1.9` | [#288](https://github.com/frankbria/iris/issues/288) | a11y reports, JUnit and history agree with the CLI verdict | P1.8 (#287) | TODO |
| `P1.10` | [#289](https://github.com/frankbria/iris/issues/289) | a11y CLI flags: validate --fail-on, allow disabling keyboard, fix --pages parsing | — | TODO |
| `P1.11` | [#290](https://github.com/frankbria/iris/issues/290) | WCAG AA level must include WCAG 2.1/2.2 AA rules | — | TODO |
| `P1.12` | [#291](https://github.com/frankbria/iris/issues/291) | Security hardening | — | TODO |
| `P1.13` | [#292](https://github.com/frankbria/iris/issues/292) | Agent loop verdict integrity: stale goalMet, trivial asserts, false-positive matching | — | TODO |
| `P1.14` | [#293](https://github.com/frankbria/iris/issues/293) | Agent loop error surfacing: provider failure and page-controlled hangs | — | TODO |
| `P1.15` | [#294](https://github.com/frankbria/iris/issues/294) | `iris run` exits non-zero on failure | — | TODO |
| `P1.16` | [#295](https://github.com/frankbria/iris/issues/295) | Security hardening | — | TODO |
| `P1.17` | [#296](https://github.com/frankbria/iris/issues/296) | Do not auto-retry non-idempotent clicks and fills | — | TODO |
| `P1.18` | [#297](https://github.com/frankbria/iris/issues/297) | Pattern translator: stop turning prose into CSS selectors | — | TODO |
| `P1.19` | [#298](https://github.com/frankbria/iris/issues/298) | Vision provider detection and Ollama timeouts | — | TODO |
| `P1.20` | [#299](https://github.com/frankbria/iris/issues/299) | AI cache and ledger hygiene: memory-tier TTL, index name collision | — | TODO |
| `P1.21` | [#300](https://github.com/frankbria/iris/issues/300) | Security hardening | — | TODO |
| `P1.22` | [#301](https://github.com/frankbria/iris/issues/301) | Security hardening | P0.7 (#235), P1.21 (#300) | TODO |
| `P1.23` | [#302](https://github.com/frankbria/iris/issues/302) | Security hardening | — | TODO |
| `P1.24` | [#303](https://github.com/frankbria/iris/issues/303) | Local history integrity: transactions, stable ordering, file permissions | — | TODO |
| `P1.25` | [#304](https://github.com/frankbria/iris/issues/304) | Security hardening | P0.2 (#230) | TODO |
| `P1.26` | [#305](https://github.com/frankbria/iris/issues/305) | Security hardening | P0.3 (#231) | TODO |
| `P1.27` | [#306](https://github.com/frankbria/iris/issues/306) | Build and smoke-test the container on every PR; tie base image to Playwright | — | TODO |
| `P1.28` | [#307](https://github.com/frankbria/iris/issues/307) | Security hardening | P0.1 (#229) | TODO |
| `P1.29` | [#308](https://github.com/frankbria/iris/issues/308) | Security hardening | P1.27 (#306) | TODO |
| `P1.30` | [#309](https://github.com/frankbria/iris/issues/309) | Graceful shutdown: drain in-flight work, readiness signal, MCP shutdown | P0.12 (#240) | TODO |
| `P1.31` | [#310](https://github.com/frankbria/iris/issues/310) | Security hardening | P0.26 (#254) | TODO |
| `P1.32` | [#311](https://github.com/frankbria/iris/issues/311) | Docs truth pass for the hosted product | P0.3 (#231), P0.45 (#273) | TODO |

### P2 — Post-launch fast-follow

| `[PX.Y]` | Issue | Title | Depends on | Status |
|----------|-------|-------|-----------|--------|
| `P2.1` | [#312](https://github.com/frankbria/iris/issues/312) | RPC observation method: screenshots and page snapshots ("eyes") | P0.24 (#252) | TODO |
| `P2.2` | [#313](https://github.com/frankbria/iris/issues/313) | Security hardening | P0.7 (#235) | TODO |
| `P2.3` | [#314](https://github.com/frankbria/iris/issues/314) | Hosted MCP over HTTP with tenant auth and metering | P0.24 (#252), P0.35 (#263), P2.2 (#313) | TODO |
| `P2.4` | [#315](https://github.com/frankbria/iris/issues/315) | Per-plan artifact storage quota | P0.29 (#257), P0.37 (#265) | TODO |
| `P2.5` | [#316](https://github.com/frankbria/iris/issues/316) | Zero-downtime deploys | P0.45 (#273), P1.30 (#309) | TODO |
| `P2.6` | [#317](https://github.com/frankbria/iris/issues/317) | Public status page | P0.47 (#275) | TODO |
| `P2.7` | [#318](https://github.com/frankbria/iris/issues/318) | Store money as integer micro-units | P0.35 (#263) | TODO |
| `P2.8` | [#319](https://github.com/frankbria/iris/issues/319) | Watcher: `--execute` targets and nested ignore globs | — | TODO |
| `P2.9` | [#320](https://github.com/frankbria/iris/issues/320) | npm package publish-readiness | — | TODO |
| `P2.10` | [#321](https://github.com/frankbria/iris/issues/321) | Local SQLite: real migration runner or delete dead migrations | P0.20 (#248) | TODO |
| `P2.11` | [#322](https://github.com/frankbria/iris/issues/322) | Accessibility of IRIS own reports | P0.18 (#246) | TODO |
| `P2.12` | [#323](https://github.com/frankbria/iris/issues/323) | Capture engine: do not force `transform: none` on every element | — | TODO |
| `P2.13` | [#324](https://github.com/frankbria/iris/issues/324) | Security hardening | — | TODO |

### P3 — Polish / test trust / hygiene

| `[PX.Y]` | Issue | Title | Depends on | Status |
|----------|-------|-------|-----------|--------|
| `P3.1` | [#325](https://github.com/frankbria/iris/issues/325) | Test trust: AI client fakes must return usage; cover the persistent cache | P0.16 (#244) | TODO |
| `P3.2` | [#326](https://github.com/frankbria/iris/issues/326) | Test trust: protocol suite runs authenticated | P0.24 (#252) | TODO |
| `P3.3` | [#327](https://github.com/frankbria/iris/issues/327) | Hygiene: stale comments and dead code in the RPC and AI layers | — | TODO |

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
