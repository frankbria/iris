# Plan 015: Watch mode AI feedback — evaluate what changed instead of replaying one canned action

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat bdf7b7d..HEAD -- src/watcher.ts src/cli.ts src/visual/capture.ts src/visual/ai-classifier.ts`
> Plan 009 is expected to have landed (provider/key wiring). STOP if watcher.ts
> no longer matches the "Current state" description.

## Status

- **Priority**: P2
- **Effort**: M (the visual pipeline pieces all exist; this is wiring + UX)
- **Risk**: MED (AI cost in a hot loop — must be debounced and budgeted)
- **Depends on**: plans/009 (AI provider/key wiring pattern)
- **Category**: direction
- **Planned at**: commit `bdf7b7d`, 2026-07-23

## Why this matters

The PRD's second user story — "UI changes trigger immediate AI evaluation … feedback appears in CLI within 2 seconds" (docs/prd.md:69-78) — is the *development companion* half of the product. Today `iris watch` re-translates and re-executes one fixed instruction (default literally `'click submit'`, src/watcher.ts:49) on every file change and never touches the vision stack. Meanwhile the repo already contains everything needed to deliver the promise: screenshot capture with stabilization (`src/visual/capture.ts`), an AI classifier producing severity/description/suggestions (`src/visual/ai-classifier.ts`), caching so unchanged pixels cost nothing (`src/ai-client/cache.ts`). This plan connects them: on change, capture the page, compare to the previous capture, and print the AI's verdict + suggestions.

## Current state

- `src/watcher.ts:42-57` — options include `instruction: options.instruction || 'click submit'`, `execute`, `headless`, debounce from config.
- `src/watcher.ts:145-175` — `executeInstruction(event)`: builds a `file://` URL from the changed file (`pathToFileURL`, watcher.ts:155-157), calls `translate(this.options.instruction, { url: fileUrl })`, optionally executes actions. No screenshots, no AI evaluation.
- `src/cli.ts:168-213` — watch command flags: `-i/--instruction` (default `'click submit'`), `--execute`, `--headless`, timeouts/retries. Passes through to `watchFiles(target, options.instruction, {...})`.
- `src/visual/capture.ts` — `VisualCaptureEngine` captures stabilized screenshots (fonts, animations, network-idle; see class in file — read it before wiring).
- `src/visual/ai-classifier.ts:243-265` — `analyzeChange({ baselineImage, currentImage, diffImage, context })` → `{ classification, confidence, description, severity, suggestions, reasoning, ... }`. Construction requires provider/key (see plans/009's wiring in `src/cli.ts` visual-diff — copy that resolution pattern).
- `src/visual/diff.ts` — pixel diff engine; use it to gate AI calls (identical/near-identical captures should not hit the AI at all).
- Watcher races on shared browser state are tracked as issue #70 — do not attempt to fix, but do not make worse: the feedback path below is sequential per change event.
- Conventions: strict TS, Jest, conventional commits, Prettier.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `npm run typecheck`      | exit 0              |
| Tests     | `npx jest __tests__/watcher*` | all pass       |
| Full gate | `npm run verify`         | exit 0              |

## Scope

**In scope**:
- `src/watcher.ts` (new feedback mode)
- `src/cli.ts` (watch command: `--feedback`, `--feedback-url <url>` flags)
- `__tests__/` watcher tests
- README watch section

**Out of scope**:
- Fixing #70 (browser-state race) — keep the new path sequential.
- The translate/execute path — existing behavior stays the default.
- Visual baselines/git integration (`src/visual/baseline.ts`) — watch feedback compares against the previous capture in-memory/tmp, NOT the baseline system.
- The `run` command.

## Git workflow

- Branch: `feat/015-watch-ai-feedback`
- Conventional commits, e.g. `feat(watch): AI feedback mode — classify UI changes on save`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Flags + provider resolution

Add to the watch command in `src/cli.ts`: `--feedback` (enable AI feedback mode) and `--feedback-url <url>` (the page to observe; falls back to `IRIS_BASE_URL`; if neither is set and the changed file is an .html file, use its `file://` URL as today — reuse the `pathToFileURL` logic location, watcher.ts:155-157). Resolve AI provider/key exactly as plans/009 did for visual-diff (same helper or same inline pattern; `'anthropic'`→`'claude'` mapping included); with no key and no ollama, `--feedback` errors out at startup with the same guidance message.

**Verify**: `npm run typecheck` → exit 0.

### Step 2: Feedback pipeline in the watcher

In `src/watcher.ts`, when feedback mode is on, replace the translate/execute behavior for each debounced change event with:
1. Navigate the (persistent) page to the feedback URL; capture via `VisualCaptureEngine` with its stabilization defaults.
2. First capture → store as reference, print "📸 reference captured".
3. Subsequent captures → run the pixel diff (`src/visual/diff.ts`) against the reference; if similarity is above the no-change threshold (reuse the diff engine's default threshold), print "no visual change" and skip AI.
4. Otherwise call `aiClassifier.analyzeChange({ baselineImage: reference, currentImage, diffImage })` and print: severity, description, and each suggestion on its own line. Update the reference to the new capture after reporting.
5. Any AI failure → print the error once and continue watching (never crash the watcher loop).

**Verify**: `npm run typecheck && npm run lint` → exit 0.

### Step 3: Cost guard

Feedback mode maintains a session counter of AI calls; after 50 calls, print a notice and require `--max-ai-calls <n>` to go higher (flag with default 50, `parseIntOption`). The cache layer (`SmartAIVisionClient` inside the classifier) already dedupes identical image pairs — rely on it, don't reimplement.

**Verify**: `npm run typecheck` → exit 0.

### Step 4: Tests

Extend/model on the existing watcher tests (`ls __tests__ | grep -i watch` to find them; they mock chokidar events — follow that pattern):
- Feedback mode, first event → capture stored, no AI call (mock `AIVisualClassifier`).
- Second event with a mocked diff below threshold → no AI call.
- Second event above threshold → AI called once; suggestions printed (console spy).
- AI throws → watcher keeps running (subsequent event still processed).
- Call-cap reached → AI not called, notice printed.

**Verify**: `npx jest __tests__/watcher*` → all pass.

### Step 5: Gate + README

README watch section: document `--feedback`, the 2-second caveat honestly (capture+stabilization typically exceeds 2s; state actual behavior), and cost characteristics (cached, capped). `npm run format`.

**Verify**: `npm run verify` → exit 0.

## Test plan

As Step 4. Mock boundaries: chokidar (existing pattern), `AIVisualClassifier`, and the diff result where needed; the watcher orchestration logic itself runs real.

## Done criteria

- [ ] `npm run verify` exits 0
- [ ] `iris watch --help` lists `--feedback`, `--feedback-url`, `--max-ai-calls`
- [ ] Tests prove: no-change skips AI; failure doesn't kill the loop; cap enforced
- [ ] Default watch behavior (no `--feedback`) byte-identical to before (existing tests untouched and green)
- [ ] `plans/README.md` status row updated

## STOP conditions

- plans/009 not landed (no provider/key resolution pattern to copy) — report.
- `VisualCaptureEngine` requires config or context that doesn't exist outside the visual-runner (e.g. storage manager coupling) — report what it needs; refactoring capture is out of scope.
- Watcher tests don't exist / use a pattern you can't extend — report before inventing new test infrastructure.

## Maintenance notes

- This makes the PRD's US2 real in v1 form (severity + suggestions on save). Deferred: streaming to IDEs, `--feedback` + `--execute` combined mode, before/after annotated screenshots in a local viewer.
- Reviewer: the reference-update ordering (update AFTER reporting, so a failed AI call doesn't lose the comparison point) and watcher-loop resilience.
- Interaction: if plans/016 lands (wider aiAnalysis surface), the printed feedback should include `reasoning` too — one-line follow-up.
