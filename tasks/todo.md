# #669 [P3.43] a11y: a page that moves on after the network went idle

## Plan (self-authored; no plan on the issue)

1. `src/a11y/scan-navigation.ts`: `onScannedDocument(page, scannedUrl, check)` turns a check's
   result or error into `NavigatedDuringScanError` when the page's scheme, host or path changed.
2. `src/a11y/a11y-runner.ts`: hold the axe scan and the screen-reader checks; run the keyboard
   checks last, not held (their key presses may navigate on purpose, #286).
3. `src/mcp/scan-errors.ts`: fixed reason "the page navigated to another page during the scan".
4. Tests: real Chromium (`__tests__/a11y/scan-navigation.test.ts`, delayed `location.replace`,
   meta refresh 2 s), mocked runner, runner cases for CI, MCP reason.
5. Docs: README, `.claude/rules/browser-safety.md`, `plans/README.md`.

## Acceptance criteria

- [x] Behaviour decided: a clear per-page error; query/fragment rewrites do not trip it.
- [x] Real-Chromium test with a delayed `location.replace` and a 2 s meta refresh.
- [x] README says what a caller sees.
