# #294: iris run exits non-zero on failure

*2026-10-10T00:29:07Z by Showboat 0.6.1*
<!-- showboat-id: c4c93f58-bb31-4852-b8e6-8fc837b2faf4 -->

Real CLI (ts-node over each tree's src), real Chromium, no mocks. 'main' is a worktree of main ($SCRATCH/main-wt); 'branch' is this PR ($REPO). fixture294.js serves a page at $PAGE (an h1 'Welcome' and a #go button) and an Ollama-shaped provider on :58941 that is up (/api/tags) but answers every generate request 503. run294.sh runs `iris run … --json` hermetically (no ambient AI keys, config file, .env or history DB), prints the JSON's status / goalMet / translation.error, and the process exit code.

## Success exits 0 on both
The goal holds: an assertion that passes.

```bash
for t in main branch; do d=$REPO; [ $t = main ] && d=$SCRATCH/main-wt; echo "$t:"; $SCRATCH/run294.sh $d "verify Welcome is visible" --url $PAGE; done
```

```output
main:
status: success  goalMet: true  translation.error: undefined
exit code: 0
branch:
status: success  goalMet: true  translation.error: null
exit code: 0
```

## Criterion: goal not met exits 1
The page has no 'Checkout'. main reports status error and goalMet false but exits 0; the branch exits 1.

```bash
for t in main branch; do d=$REPO; [ $t = main ] && d=$SCRATCH/main-wt; echo "$t:"; $SCRATCH/run294.sh $d "verify Checkout is visible" --url $PAGE; done
```

```output
main:
status: error  goalMet: false  translation.error: undefined
exit code: 0
branch:
status: error  goalMet: false  translation.error: null
exit code: 1
```

## Criterion: a failed action exits 1
#nope does not exist; the click fails after the executor's retries.

```bash
for t in main branch; do d=$REPO; [ $t = main ] && d=$SCRATCH/main-wt; echo "$t:"; $SCRATCH/run294.sh $d "click #nope" --url $PAGE --timeout 2000; done
```

```output
main:
status: error  goalMet: null  translation.error: undefined
exit code: 0
branch:
status: error  goalMet: null  translation.error: null
exit code: 1
```

## Criterion: a provider outage is a failure with its reason (maintainer note from #293)
The provider answers 503. main exits 0 and the JSON has no error field (the reason is lost: undefined); the branch exits 1 with translation.error naming the failure.

```bash
for t in main branch; do d=$REPO; [ $t = main ] && d=$SCRATCH/main-wt; echo "$t:"; OLLAMA_ENDPOINT=http://127.0.0.1:58941 $SCRATCH/run294.sh $d "make sure the cart total adds up" --dry-run; done
```

```output
main:
status: error  goalMet: null  translation.error: undefined
exit code: 0
branch:
status: error  goalMet: null  translation.error: Ollama request failed: 503 (status=503)
exit code: 1
```

## Criterion: a usage error exits 2
--agent needs a starting URL; nothing is launched. The JSON envelope still lands on stdout.

```bash
for t in main branch; do d=$REPO; [ $t = main ] && d=$SCRATCH/main-wt; echo "$t:"; $SCRATCH/run294.sh $d "buy a widget" --agent; done
```

```output
main:
status: error  goalMet: null  translation.error: (no translation)
exit code: 0
branch:
status: error  goalMet: null  translation.error: (no translation)
exit code: 2
```

## The exit code survives a pipe, and the piped JSON is complete
An assistant pipes --json into a parser. PIPESTATUS[0] is iris's own code; the parser received the whole object (exitCode, not exit(), so stdout is flushed).

```bash
cd $REPO; IRIS_CONFIG_PATH=$SCRATCH/empty/none.json IRIS_DOTENV_DIR=$SCRATCH/empty IRIS_DB_PATH=$SCRATCH/demo294.db TS_NODE_TRANSPILE_ONLY=1 node -r ts-node/register src/cli.ts run "verify Checkout is visible" --url $PAGE --json 2>/dev/null | node -e "let s=\"\";process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>{const j=JSON.parse(s);console.log(\"parsed\",s.length,\"bytes; status:\",j.status,\"results:\",j.results.length)})"; echo "iris exit: ${PIPESTATUS[0]}"
```

```output
parsed 857 bytes; status: error results: 2
iris exit: 1
```
