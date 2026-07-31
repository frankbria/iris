# IRIS Plans — Single Source of Truth

This is the **canonical "what's next" tracker** for IRIS. If another planning
doc disagrees with this file, this file wins.

- Active work is tracked as GitHub issues with `[PX.Y]` priority codes
  (**X** = tier, 0 = highest; **Y** = order within tier by importance/dependency).
- Roadmap / future-phase design lives in `docs/` (see _Reference docs_ below).
- Superseded planning artifacts are in `docs/archive/`.

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
| 012 | `P1.13` | MCP server spike — one real tool, verified in Claude Code | [#114](https://github.com/frankbria/iris/issues/114) | — | TODO |
| 017 | `P2.5` | Canonical-surface decision + README/PRD truth pass | [#115](https://github.com/frankbria/iris/issues/115) | — | DONE |
| 013 | `P2.6` | Assertion vocabulary (`verify/make sure` representable, `goalMet`) | [#116](https://github.com/frankbria/iris/issues/116) | 010 | DONE |
| 014 | `P2.7` | Agentic observe→act loop (`iris run --agent`) | [#117](https://github.com/frankbria/iris/issues/117) → subs [#121](https://github.com/frankbria/iris/issues/121), [#122](https://github.com/frankbria/iris/issues/122) | 010, 013 | TODO |
| 015 | `P2.8` | Watch-mode AI feedback (classify changes on save) | [#118](https://github.com/frankbria/iris/issues/118) | 009 | TODO |
| 016 | `P2.9` | Surface dropped AI intelligence; diff image into vision request | [#119](https://github.com/frankbria/iris/issues/119) → subs [#123](https://github.com/frankbria/iris/issues/123), [#124](https://github.com/frankbria/iris/issues/124) | 009 | TODO |

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
