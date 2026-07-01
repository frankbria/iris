# Issue #64 — [P1.2] JSON-RPC WebSocket server has no authentication

## Context
`connect` starts the WS server with no auth. The origin guard only rejects
connections that *carry* an Origin header, so any origin-less local process
(non-browser) can call `launchBrowser`/`executeBrowserAction` unauthenticated.

Acceptance criteria 3 (Zod schema bounding launchBrowser options) and the
`urlPolicy` strip are **already done** by prior SSRF work (#60/#61). Remaining
gap: **per-session token on the handshake**.

## Design
Token transport = `Authorization: Bearer <token>` **header**. The threat is
cross-site WebSocket hijacking by a browser page — browsers cannot set custom
headers on a WebSocket, so a header token is unforgeable from the untrusted
(browser) surface, while trusted local tooling sets it easily. Constant-time
compare via `crypto.timingSafeEqual`.

Auth is enforced only when `authToken` is configured (backward-compatible with
existing tests / programmatic embedding). The shipped `connect` CLI **always**
generates one with `randomBytes(32)` and prints it + usage. Bind stays 127.0.0.1.

## Steps (TDD)
1. RED: tests — required-token server rejects no-token (1008), wrong-token
   (1008), origin-less-without-token (1008); accepts correct bearer token.
2. GREEN: `protocol.ts` — `authToken?` option; bearer extract + timing-safe
   check in `wss.on('connection')` after the origin check.
3. `cli.ts connect` — generate token, pass it, print token + trust model note.
4. Document trust model (code comment).
5. verify: typecheck + lint + test; `prettier --write` touched files before push.
