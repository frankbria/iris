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
