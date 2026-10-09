# #293: provider failures are errors; a hung page cannot hang a run

*2026-10-09T04:57:13Z by Showboat 0.6.1*
<!-- showboat-id: fe165c65-5099-46ac-8a3f-293e088a76d8 -->

Real CLI and runners (ts-node over each tree's src), real Chromium. 'main' is a worktree of main ($SCRATCH/main-wt); 'branch' is this PR ($REPO). fixture.js serves /ok (a cart), /hung (spins its main thread 50 ms after load) and a fake Ollama /api/generate that answers 400 (fail) or a one-assert plan (ok). agent293.sh runs `iris run --agent --json` under a 60 s cap (exit 124 = hung). runners293.ts runs the tree's own VisualCaptureEngine (animations off + a mask, as every default visual run) or AccessibilityRunner.

## Criterion 1: provider errors propagate as `error`
The provider answers HTTP 400. main asks it twice and blames the model (`no_actions`); the branch stops after one call with `error`.

```bash
echo main:; $SCRATCH/agent293.sh $SCRATCH/main-wt fail /ok; echo branch:; $SCRATCH/agent293.sh $REPO fail /ok
```

```output
main:
terminationReason: no_actions  turns: 2  status: error
provider calls: 2
branch:
terminationReason: error  turns: 1  status: error
provider calls: 1
```

## Criterion 2a: the agent loop on a page that never yields
The provider answers a one-assert plan. On main the run hangs while observing the page (page.title() has no timeout) and the provider is never asked; on the branch the observation degrades and the run finishes.

```bash
echo main:; $SCRATCH/agent293.sh $SCRATCH/main-wt ok /hung; echo branch:; $SCRATCH/agent293.sh $REPO ok /hung; pkill -f "[h]eadless_shell"; true
```

```output
main:
HUNG: no result after 60 s (timeout killed it)
provider calls: 0
branch:
terminationReason: goal_met  turns: 1  status: success
provider calls: 1
```

## Criterion 2b: visual capture on a page that never yields
Animations off and one mask, as every default visual run (and every hosted visual job) captures. On main the style injection waits until the cap kills it; on the branch the capture fails with a reason.

```bash
echo main:; $SCRATCH/cap.sh $SCRATCH/main-wt capture; echo branch:; $SCRATCH/cap.sh $REPO capture
```

```output
main:
capture success: false  error: page.addStyleTag: Target page, context or browser has been closed
HUNG: no result after 90 s
branch:
capture success: false  error: The page did not respond (style injection timed out)
```

## Criterion 2c: the a11y runner on a page that hangs during the keyboard checks
axe has its own 30 s timeout, so a page frozen at load already errors on main. This page is fine until a key is pressed (the focus-order walk presses Tab), then its main thread spins and every later page.evaluate waits. A /ok page follows it. On main the run never reaches /ok; on the branch the hung page is its own error after the 5 s deadline and /ok is scanned.

```bash
echo main:; $SCRATCH/cap.sh $SCRATCH/main-wt a11y hungkey; echo branch:; $SCRATCH/cap.sh $REPO a11y hungkey
```

```output
main:
HUNG: no result after 90 s
branch:
/hungkey: The page did not finish within 5 s
/ok: scanned, 6 axe passes
pagesErrored: 1
```

## Criterion 3: tests with a failing provider and a never-resolving page
The provider test drives a real HTTP server answering 400; the hung-page tests drive real Chromium (positive control: the page's title really never answers). Each was red before its fix (no_actions / Jest timeout; the a11y keyboard-hang test exceeds 60 s on main).

```bash
npx jest --json --outputFile=$SCRATCH/t.json __tests__/hung-page.test.ts __tests__/agent-loop.test.ts __tests__/a11y/a11y-page-isolation.test.ts -t "293|never yields|keyboard checks|withPageTimeout|no_actions" >/dev/null 2>&1; node -e "const r=require(process.argv[1]);for(const f of r.testResults)for(const t of f.assertionResults)if(t.status!==\"pending\")console.log(t.status.padEnd(7),t.fullName);console.log(\"passed\",r.numPassedTests,\"failed\",r.numFailedTests)" $SCRATCH/t.json
```

```output
passed  agent loop runAgentLoop ends with error, not no_actions, when the provider fails (#293)
passed  agent loop runAgentLoop still treats a plan the model answered empty as no_actions
passed  a11y runner page isolation (#287) errors a page that hangs during the keyboard checks instead of waiting forever (#293)
passed  a page that never yields observePage returns a degraded digest instead of waiting forever
passed  a page that never yields capture fails with an error result instead of waiting forever
passed  a page that never yields capture with animations off and masks fails instead of waiting forever
passed  a page that never yields capture metadata falls back rather than waiting forever
passed  a page that never yields the executor page context keeps its URL and drops the title
passed  withPageTimeout passes a settled call through
passed  withPageTimeout answers the fallback when the call never settles
passed 10 failed 0
```

## Evidence

| Criterion | Action | Outcome evidence | Status |
|---|---|---|---|
| Provider errors propagate as `error` | `iris run --agent`, provider answers 400 | main: `no_actions`, 2 turns, 2 provider calls; branch: `error`, 1 turn, 1 call | VERIFIED |
| Page-evaluated calls bounded: agent loop | `iris run --agent` on /hung | main: hung 60 s, provider never asked; branch: finished (`goal_met`, 1 turn) | VERIFIED |
| Bounded: visual capture | capture /hung, animations off + mask | main: hung 90 s; branch: `success: false`, "The page did not respond" | VERIFIED |
| Bounded: a11y runner | a11y on /hungkey then /ok | main: hung 90 s, /ok never scanned; branch: /hungkey errored at 5 s, /ok scanned, pagesErrored 1 | VERIFIED |
| Tests: failing provider + never-resolving page | jest, the 10 #293 tests | 10 passed, 0 failed; each red before its fix | VERIFIED |
