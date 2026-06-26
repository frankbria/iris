# IRIS Plans — Single Source of Truth

This is the **canonical "what's next" tracker** for IRIS. If another planning
doc disagrees with this file, this file wins.

- Active work is tracked as GitHub issues with `[PX.Y]` priority codes
  (**X** = tier, 0 = highest; **Y** = order within tier by importance/dependency).
- Roadmap / future-phase design lives in `docs/` (see _Reference docs_ below).
- Superseded planning artifacts are in `docs/archive/`.

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
