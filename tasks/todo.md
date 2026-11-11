# #362 [P2.2] MCP tool: follow-up items

Plan self-authored from the checklist Frank posted on the issue (2026-11-08). The paste was
cut at the terminal's right edge in two places; the four checklist items are readable.

## Findings

- `readOnlyHint: true` is wrong: the tool loads any page in a real browser, which runs its
  scripts and sends the requests a visit would.
- Errors pass through the first line of whatever was thrown: a browser launch failure names
  local paths, the pre-flight error echoes a malformed URL with its `user:password@`, and
  the guard's redirect error carries the refused target URL verbatim.
- A redirect's landing URL goes into `structuredContent.url` and the summary as is, query
  string and fragment included. The page under test chooses that text.
- Each call launches its own Chromium with no bound on how many run at once.

## Plan

1. `src/mcp/scan-errors.ts` (new, pure): `scanFailureReason(detail)` maps a failure to a
   fixed vocabulary (policy block with its category, redirect to a blocked address, a
   `net::ERR_*` code, timeout, otherwise "the scan could not be completed");
   `landedUrl(requested, scanned)` gives origin and path of a redirect's landing page,
   bounded. The request URL is shown through `redactString` (src/log.ts). The raw detail
   goes to stderr through `log()`.
2. `src/mcp/scan-limiter.ts` (new, pure): at most 2 scans at once, 8 more wait in arrival
   order, further calls get a tool error at once.
3. `src/mcp/tools.ts`: hints `readOnlyHint: false, destructiveHint: true,
   idempotentHint: false, openWorldHint: true`; use 1 and 2; output gains `redirected`;
   the stale header comment (keyboard checks "hardcode success") is corrected.
4. Tests: unit files for 1 and 2 (no browser, run locally); `__tests__/mcp/tools.test.ts`
   gets the hints, a redirect with a token in its query, a blocked redirect that names no
   target, credentials in the request URL, and four parallel calls against a fixture that
   holds its responses (never more than two in flight).
5. Docs: README MCP section, `.claude/rules/rpc-server.md`, `plans/README.md` (P2.2 row, and
   the P0.54 row per the owner's standing instruction).

## Decisions (no architectural fork)

- `destructiveHint: true`: the tool cannot promise that a GET of a URL the model chose
  changes nothing, so it does not claim it.
- A full queue is a tool error rather than an unbounded wait.
- The cap is a constant; hosted MCP (#314) will need a per-tenant one.
- Not in the checklist, so not done: a `keyboard` input, `passed` versus `--fail-on`.

## Acceptance criteria
- [ ] Accurate tool hints
- [ ] Errors normalised (no internal host, port or path)
- [ ] Redirect targets not echoed verbatim
- [ ] Concurrency cap
- [ ] Each item is covered by a regression test
