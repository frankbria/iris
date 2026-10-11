# #296: a click or fill that may have happened is not repeated

*2026-10-11T21:09:20Z by Showboat 0.6.1*
<!-- showboat-id: 527a041f-69f4-4142-832d-167ad6206f63 -->

Real ActionExecutor, real Chromium, a local shop page whose Buy button POSTs an order. The evidence is how many orders the server received. 'Before' is origin/main, 'after' is this branch. `$SCRATCH` holds the demo script (double-submit.js), `$MAIN` is a checkout of origin/main (its node_modules serve both runs), and `$PWD` is this branch.

## Criterion 2: a click whose handler throws after submitting is not repeated. Real Chromium resolves page.click when the handler throws, so nothing is injected here.

```bash
INJECT=0 node $SCRATCH/double-submit.js $PWD $MAIN
```

```output
click result: success=true error="undefined"
orders the shop received: 1
```

## Criterion 1: a click that fails after it was dispatched is not retried. Chromium never fails page.click after dispatching on demand, so the script wraps the real click: the real press posts the order, then the wrapper throws the protocol error a mid-dispatch failure produces.

```bash
echo '== before (origin/main)'; node $SCRATCH/double-submit.js $MAIN $MAIN; echo '== after (this branch)'; node $SCRATCH/double-submit.js $PWD $MAIN
```

```output
== before (origin/main)
click result: success=false error="Protocol error (Input.dispatchMouseEvent): Target closed"
orders the shop received: 4
== after (this branch)
click result: success=false error="Protocol error (Input.dispatchMouseEvent): Target closed"
orders the shop received: 1
```

Errors that prove nothing was dispatched never reach the executor: Playwright re-resolves a detached element itself (it throws 'Element is not attached to the DOM' only under noAutoWaiting, which IRIS never sets), and a pre-dispatch failure surfaces as a timeout, already not retried (#75). So click and fill are simply never retried; navigate keeps its retries. Pinned by tests:

```bash
npx jest __tests__/executor.test.ts __tests__/assert-execution.test.ts --ci -t '296|should retry failed actions|transient network' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E 'Tests:'
```

```output
Tests:       63 skipped, 9 passed, 72 total
```
