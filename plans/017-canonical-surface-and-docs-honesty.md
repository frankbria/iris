# Plan 017: Pick the canonical integration surface and make the docs tell the truth

> **Executor instructions**: Follow this plan step by step. This plan is mostly
> documentation and a decision record — it modifies NO source code. Run every
> verification command. If anything in "STOP conditions" occurs, stop and
> report. When done, update the status row in `plans/README.md` — unless a
> reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat bdf7b7d..HEAD -- README.md docs/prd.md docs/tech_specs.md`
> Drift here is likely benign (docs move often); reconcile with the live text
> and keep going unless the documents' claims have already been rewritten to
> match reality (then report DONE-already).

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (docs + one decision record; no code)
- **Depends on**: none (but reads better after plans/011 and /012 exist as direction)
- **Category**: docs
- **Planned at**: commit `bdf7b7d`, 2026-07-23

## Why this matters

A vision-alignment audit (2026-07-23) found that four of the PRD's five user stories are unbuilt (autonomous exploration, real-time AI feedback, NL validation with assertions, design-system compliance), yet README/PRD present them as the product's identity — and IRIS simultaneously maintains three divergent integration surfaces: the CLI (real, documented), a WebSocket JSON-RPC server (`iris connect`, orphaned — no assistant can consume it, two of its methods return hardcoded mock data, tracked #80), and a proposed MCP server (design doc only; plans/012). Docs that promise what no code path attempts erode trust with exactly the early adopters the project needs, and three surfaces mean triple maintenance for one product. This plan (a) records the canonical-surface decision, (b) makes README/PRD honest about what ships vs. what's roadmap, (c) explicitly defers or re-scopes the unbuilt pillars.

## Current state

- **Three surfaces**: `src/cli.ts` (5 commands; real); `src/protocol.ts` (WS JSON-RPC: executeCommand/launchBrowser/closeBrowser/getBrowserStatus/executeBrowserAction real, getStatus + streamLogs hardcoded stubs at protocol.ts:214-222); `claudedocs/research_iris_claude_code_plugin_20251012.md` (MCP design, unimplemented; plans/012 is the spike).
- **README claims to check** (verify each against the live file — line numbers drift): "Natural language UI commands with AI translation" (true but only click/fill/navigate — no assertions); "JSON-RPC protocol for AI coding assistant integration" (misleading — no assistant can consume it); Phase-2 feature list (largely true for visual/a11y machinery; `--semantic` reachability depends on plans/009 landing).
- **PRD user stories** (docs/prd.md:56-109): US1 exploration ABSENT, US2 real-time AI feedback ABSENT (plans/015 is v1), US3 NL validation PARTIAL (plans/013/014), US4 design compliance ABSENT, US5 intelligent visual regression real-but-was-unreachable (plans/009). Phase 3 (prd.md:147-159): MCP/adapters ABSENT (plans/012).
- **Repo doc conventions**: `plans/README.md` is the canonical status tracker ("If another planning doc disagrees with this file, this file wins" — plans/README.md:3-4); superseded planning goes to `docs/archive/`; decision docs live flat in `docs/`.
- **The decision this plan records** (made by the maintainer via the 2026-07-23 audit review): **CLI is the canonical surface today; MCP (plans/012) is the strategic assistant bridge; the WS JSON-RPC server is legacy-experimental — kept running but frozen (no new features), pending retirement review after the MCP spike ships.** If the maintainer wants a different outcome, they'll say so on the issue for this plan — the executor implements the decision as stated here.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Docs lint (links) | `npx markdown-link-check README.md` (if unavailable, manual click-through) | no broken internal links |
| Full gate | `npm run verify`         | exit 0 (no code changed — must stay green) |

## Scope

**In scope**:
- `README.md`
- `docs/prd.md` (status annotations only — do not rewrite the vision)
- `docs/integration-surfaces.md` (new decision record)
- `plans/README.md` (status row)

**Out of scope**:
- ANY file under `src/` or `__tests__/` — this plan changes zero code.
- Deleting `src/protocol.ts` or the connect command (explicitly deferred to post-MCP-spike review).
- `docs/tech_specs.md` deep rewrite (add one banner note only, see Step 3).

## Git workflow

- Branch: `docs/017-canonical-surface-honesty`
- Conventional commits, e.g. `docs: record integration-surface decision; align README/PRD claims with shipped reality`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Decision record

Create `docs/integration-surfaces.md`: context (three surfaces, audit date), the decision as stated in "Current state" above, consequences (connect frozen; README repositioning; MCP spike = plans/012), and revisit trigger (after MCP spike outcome). Keep it under a page; link plans/012 and issues #80.

**Verify**: file exists; `npm run verify` → exit 0.

### Step 2: README truth pass

- Reposition the JSON-RPC bullets: move `iris connect` under an "Experimental / legacy" heading with one sentence of honest status ("custom WS protocol; no assistant integrates with it today; frozen pending MCP direction — see docs/integration-surfaces.md").
- In the feature list, annotate NL commands with their real vocabulary ("click, fill, navigate — assertion and goal verification in progress, see plans/").
- Add a short "Roadmap vs. shipped" block: shipped (visual regression, a11y/axe, NL macros) vs. in-progress (semantic AI reachability, assertions, MCP bridge, watch feedback) vs. not-started (autonomous exploration, design-system compliance). Source of truth pointer to `plans/README.md`.

**Verify**: `grep -n "eyes and hands" README.md` still present (vision statement stays; claims get qualified, not deleted). Manual read-through for contradictions.

### Step 3: PRD + tech_specs status annotations

- `docs/prd.md`: under each of the five user stories, add a one-line status marker: `> **Status (2026-07-23):** Not started | In progress (plans/NNN) | Shipped (caveats)` using the mapping in "Current state". Add the same marker under Phase 3.
- `docs/tech_specs.md`: single banner note at top: "Describes target architecture. For what is actually implemented and the current integration-surface decision, see plans/README.md and docs/integration-surfaces.md."

**Verify**: `grep -c "Status (2026-07-23)" docs/prd.md` → ≥ 6.

### Step 4: Cross-link and close the loop

Ensure `plans/README.md` Cycle 3 table links this plan; ensure README's roadmap block links `plans/README.md`; run the link check.

**Verify**: `npm run verify` → exit 0 (proves no code was touched).

## Test plan

No code tests. Verification is grep-based checks above plus a full manual read of README for internal contradictions (the most common failure of truth passes: fixing one claim while a duplicate claim two sections later still overpromises — search for "JSON-RPC", "natural language", "AI" occurrences and check each).

## Done criteria

- [ ] `docs/integration-surfaces.md` exists with decision + revisit trigger
- [ ] README: connect repositioned as experimental/legacy; roadmap-vs-shipped block present
- [ ] All five PRD user stories + Phase 3 carry status markers
- [ ] `git diff --stat` shows ONLY README.md, docs/prd.md, docs/tech_specs.md, docs/integration-surfaces.md, plans/README.md
- [ ] `npm run verify` exits 0
- [ ] `plans/README.md` status row updated

## STOP conditions

- The docs have already been rewritten to match reality (a parallel effort landed) — report DONE-already with evidence.
- You find yourself wanting to change code or delete the protocol — out of scope; report the temptation as a note instead.
- Issue #71 (docs/packaging accuracy blockers) turns out to have overlapping in-flight work — check `gh pr list --search "71"` first; coordinate rather than collide.

## Maintenance notes

- Revisit trigger is explicit: when plans/012's spike verdict lands, schedule the retire-or-invest decision on `src/protocol.ts` (issue it then).
- Reviewer: check that qualifications are honest but not self-flagellating — "in progress, see plan" not "broken".
- The PRD's vision text is deliberately preserved: the audit's conclusion was to *close* the gap (plans 009-016), not shrink the vision; annotations keep ambition and honesty simultaneously visible.
