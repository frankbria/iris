# Issue #352 — [P1.16] Typed values: credential references

Plan self-authored: the issue points at the private backlog (not on this box), so the criteria
below are derived from the issue summary ("credential references for fill values, resolved
only at fill time"), ADR 0001 §5 (the operator's secrets never serve a tenant) and probes of
the current code. Please check them against the backlog's P1.16 list.

## What leaks today (probed, Playwright 1.62)
- A fill value is in the instruction, so it goes to the AI provider, and comes back in the plan.
- The agent loop's page digest (`ariaSnapshot`) shows typed values, password fields included,
  and goes to the AI on the next turn.
- A failed `page.fill` error quotes the value (`- fill("…")` in the call log), and that error
  reaches the RPC reply, run history (org-readable) and logs.

## Steps
1. `src/credential-refs.ts`: `{{secret:NAME}}` (whole fill value, NAME `[A-Za-z_][A-Za-z0-9_]{0,63}`),
   `SecretSource = (name) => string | undefined`, `envSecrets()` (`IRIS_SECRET_<NAME>`),
   `mapSecrets(record)` (own keys only), `resolveFillText()` (throws `CredentialReferenceError`:
   unknown name, or a reference that is not the whole value), `scrubValues()`.
2. Executor: `executeAction(action, page, secrets?)` / `executeActions(…, secrets?)`. The source
   defaults to `envSecrets()` locally and to none under `IRIS_HOSTED` (fail closed). The value is
   resolved inside `performAction` only; the action in the result keeps the reference. A fill's
   error has its typed value cut (literal values too). A reference error is non-retryable.
   The executor keeps the values it resolved from references; `redactSecrets(text)` cuts them.
3. Agent loop: the digest goes through `executor.redactSecrets()` before it reaches the model.
4. RPC `executeBrowserAction` takes `secrets?: Record<NAME, string>`, request-scoped, never
   stored; it is the only source for RPC (never the server's env, local or hosted).
5. AI prompts (3 text clients): keep `{{secret:NAME}}` verbatim as the whole fill text.
6. `jest.setup.ts` scrubs `IRIS_SECRET_*`. Docs: README, CLAUDE.md, docs/data-flows.md.

## Decisions
- Values come from the caller (request `secrets` on RPC, `IRIS_SECRET_*` env for the CLI), not
  an org vault in Postgres. Hosted surfaces with fills are RPC only (jobs do not fill; the agent
  loop is CLI-only, #428), and the client already holds its credentials. A vault can be added
  later as another `SecretSource` without changing the syntax.
- Whole-value references only: a reference embedded in other text is an error, not literal text.

## Acceptance criteria (derived)
- [ ] A fill can name a credential by reference; the value is resolved only at fill time
- [ ] The value never reaches the AI (instruction, plan, agent digest), results, history or logs
- [ ] Unknown / malformed references fail the action with a message naming the reference only
- [ ] Hosted: the server process env is never a source
- [ ] Each covered by a regression test
