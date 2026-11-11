# #645 [P3.34] stripUserinfo and redactString leave part of a password that contains an @ or a space

## Plan (self-authored; no plan on the issue)

Both helpers cut `scheme://userinfo@` from free text with a pattern that stopped at the
first `@`. A URL parser takes the last `@` of the authority.

## Decisions

- **Both patterns become `[^\s/?#]*@`** (the issue's wording): greedy to the last `@`
  before `/`, `?`, `#` or whitespace, which is where a parser ends the authority.
- **A raw space in a password stays out of the pattern's reach, on purpose.** In prose a
  space ends a URL; reading on to a later `@` would eat ordinary text
  (`see http://host and mail a@b`). Instead, whoever knows the URL says so:
  `urlWithoutUserinfo(url)` parses a URL held whole, and `stripUserinfo(text, quotedUrl)`
  replaces each occurrence of a URL the text is known to quote by its parsed form, then
  runs the pattern.
- **Call sites that hold the URL**: a11y page errors (`erroredPage`, the URL navigated), stored RPC
  errors (the navigation target). The history store's private `withoutCredentials` is
  replaced by the shared helper. The MCP module keeps its own (`withoutCredentials`,
  `loggedDetail`): it answers "the requested URL" for unparseable text, a different contract.
- **Not changed**: the hosted job API already refuses a URL with credentials (400), so
  stored a11y and visual page URLs carry none; `redactString` gets the pattern fix only.

## Steps

1. [x] Tests first: `__tests__/url-credentials.test.ts` (pure), history-store cases (Postgres),
   one a11y runner case (browser, CI only on this host).
2. [x] `src/report-encoding.ts`: pattern, `urlWithoutUserinfo`, `stripUserinfo(text, quotedUrl?)`.
3. [x] `src/log.ts`: `USERINFO` pattern.
4. [x] Call sites: `src/a11y/a11y-runner.ts`, `src/history-store.ts`.
5. [x] Docs: `.claude/rules/{rpc-server,ai-and-visual,hosted-data}.md`, `plans/README.md`.

## Acceptance criteria

- [ ] Both patterns cut up to the last `@` of the authority, with tests for `user:a@b@host`
  and for a URL whose query holds an `@` (left alone)
- [ ] Where the text is known to be one URL, credentials are cut by parsing it; what free
  text with a space in a password gets is decided and documented
