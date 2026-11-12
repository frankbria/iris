---
paths:
  - "jest.setup.ts"
  - "jest.config.*"
  - "__tests__/**"
---

### Test Hermeticity (issue #185)

`jest.setup.ts` is where the suite is insulated from the developer's machine.
Three guards live there, all for the same reason — a test must not behave
differently because of an untracked file or an exported shell variable:

- `IRIS_DB_PATH` -> a per-worker temp DB, so runs never write to `~/.iris/iris.db`
- `IRIS_DATA_DIR` -> a per-worker-pid temp dir, emptied at the start of every test file
  (#241). Not an `afterAll`: a setup file's `afterAll` runs before the test file's own.
  Assigned unconditionally: a reused ledger carries spend between files and trips
  the budget breaker in a test that spent nothing
- `IRIS_CONFIG_PATH` -> `<that dir>/config.json`, which never exists, so the developer's
  real `~/.iris/config.json` (budgets, provider) never reaches a test. `config.test.ts`
  unsets it to test the default location
- `IRIS_MODEL_PROBE=0` -> no provider model-list lookups (#184)
- `IRIS_DOTENV_DIR` -> a per-worker temp directory, created 0700 and swept of any stray
  `.env`, so `loadDotenv()` finds nothing (#185). Assigned **unconditionally** — unlike
  the two above, an ambient value here is the hazard, not a preference —
  plus a one-time scrub of `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `OLLAMA_ENDPOINT` /
  `*_MODEL` / `IRIS_BASE_URL` for the shell-export route

`runCli()` calls `loadDotenv()` **during** the test body, so a `beforeEach`
scrub cannot close the `.env` hole — the guard has to stop the read itself. And
it belongs in `jest.setup.ts`, not per file: `visual-cli.test.ts` had a local
`loadDotenv` stub while `cli.test.ts` and `a11y-cli.test.ts` did not, which is
exactly how #185 shipped. The scrub is deliberately once per file, never in a
`beforeEach` — `visual-cli.test.ts` assigns those vars inside test bodies to
exercise provider resolution.

Adding a new variable that IRIS reads from the environment? Add it to the scrub
list too, or the suite silently becomes machine-dependent again.

### Ports for Spawned Processes (issue #666)

Jest runs suites in parallel and many of them listen on port 0, so a port that was free
when a test probed it can be bound by another worker before the test's child process
listens. CI failed that way once: `Cannot listen on 127.0.0.1:41865: address already in
use` in `api-key-auth.test.ts`, green on a re-run. It is not #142: no deadline is involved,
and the error names the port. `__tests__/utils/ports.ts` is the only place a port is probed
(`ports.test.ts` fails on a `freePort` anywhere else):

- **`iris connect` is spawned on port 0** and the port read from its `listening` line with
  `connectPort(output)` (#364 made the line print the bound port). A spawn that must exit
  before it listens takes `0` too.
- **A process that cannot report a port it chose** (nginx, Next's `PORT`, `--metrics-port`,
  which refuses 0) goes through `onFreePorts(count, host, start)`: `start` throws
  `PortTaken` when the process says the port was taken (`Cannot serve metrics …
  EADDRINUSE`, nginx's `bind() … failed (98: Address in use)`, Node's `EADDRINUSE`), and it
  is run again on fresh ports, five times at most. Any other failure is thrown at once.
- **Cut the readiness poll by the process's exit.** Whoever took the port may accept the
  connection and never answer, and a `fetch` or `https.request` with no signal then waits
  for good while the child that lost the port has long exited. Pass the poll an
  `AbortSignal` tied to the exit (`containerExit(name)` for a container, the child's `exit`
  promise otherwise). Each of the three suites has a test that holds a port with a silent
  listener and expects `PortTaken`; a stand-in listener must destroy the sockets it
  accepted, or its own `close()` never calls back.
- **`closedPort(host)`** is for a test of a refused connection only. Never start a listener
  on it.
- Not a fix: a longer wait or fewer workers (CLAUDE.md, #142).
