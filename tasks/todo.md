# Issue #294 — [P1.15] `iris run` exits non-zero on failure

Plan self-authored (no plan on the issue). No architectural fork; approved autonomously.

## Steps
1. `TranslationResult.error?: string` (src/translator.ts): `translate()` carries the text
   client's `AITranslationResponse.error` (#293), and sets it where the provider was asked and
   failed (client unavailable, a throw). No AI configured / no tenant credentials stays a plan
   with no actions, not an outage.
2. Hosted RPC (src/protocol.ts): on IRIS's managed key, `error` gets the same rewrite as
   `reasoning` (#479), so the vendor account's details are logged, not returned.
3. `iris run` (src/cli.ts): sets `process.exitCode` from the run, not `process.exit()`, so a
   piped `--json` payload is flushed: 0 success, 1 failure / goal not met (an outage too),
   2 usage error (`--agent` without a URL, `--agent --dry-run`). A translation with `error` is
   reported as the failure reason (stderr, and `translation.error` in the JSON).
4. Tests: in-process cli.test.ts cases assert `process.exitCode` per path; a spawned real
   `iris run` proves the status reaches the OS and the JSON is complete; translator test for
   `error`; protocol test for the managed rewrite.
5. Docs: README exit-code table and the `run` JSON notes; CLAUDE.md.

## Decisions
- Exit 1 (not 3) for a provider outage: the issue specifies 0/1/2, and the agent loop's
  outcome carries no reason to tell an outage apart. `translation.error` distinguishes it.
- Commander's own parse errors keep commander's exit code (#496 owns that inconsistency).

## Acceptance criteria
- [ ] Documented exit codes (0 success, 1 failure/goal not met, 2 usage error)
- [ ] CLI tests assert exit codes
