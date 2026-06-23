# Plan 003: Harden the `iris connect` JSON-RPC WebSocket server

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If any
> STOP condition occurs, stop and report — do not improvise. When done, update
> this plan's status row in `plans/README.md` unless a reviewer told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 65633a6..HEAD -- src/protocol.ts src/cli.ts __tests__/protocol.test.ts`
> If any changed since this plan was written, compare the "Current state"
> excerpts against the live code; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: 001 (the `ws` upgrade) is recommended first but not strictly required
- **Category**: security
- **Planned at**: commit `65633a6`, 2026-06-21
- **Issue**: https://github.com/frankbria/iris/issues/3

## Why this matters

`iris connect` starts a JSON-RPC server that can launch a browser and execute
browser actions on command. Today it (a) binds on **all network interfaces**
(no host given to `WebSocketServer`, so it listens on `0.0.0.0`), (b) performs
**no `Origin` check**, and (c) does **no schema validation** on RPC params
(`params` is typed `any` and destructured directly). Consequences: any host on
the same network can drive the browser, and any web page the user visits can
open a WebSocket to `localhost:<port>` and issue commands (cross-site WebSocket
hijacking). The remediation is standard defensive hardening — bind to loopback,
validate the `Origin` header, and validate request params with `zod` (already a
dependency). This plan does not add exploit tooling; it closes the exposure.

## Current state

`src/protocol.ts:6-10` — params are untyped:

```ts
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: any;
}
```

`src/protocol.ts:40-70` — server binds with no host/origin checks:

```ts
export function startServer(port: number, options?: { sessionTimeout?: number }): WebSocketServer {
  const wss = new WebSocketServer({ port });
  // ...
  wss.on('connection', (ws) => {
    ws.on('message', async (data) => {
      let req: JsonRpcRequest;
      try { req = JSON.parse(data.toString()); } catch { return; }
      const res: JsonRpcResponse = { jsonrpc: '2.0', id: req.id };
      try {
        switch (req.method) {
          case 'executeCommand': {
            const { instruction } = req.params;          // <-- no validation
            res.result = translateSync(instruction);
            break;
          }
          case 'executeBrowserAction': {
            const { instruction, actions, url } = req.params;   // <-- no validation
            // ...
          }
        }
      }
    });
  });
}
```

`src/cli.ts:179-184` — the only production call site:

```ts
.command('connect [port]')
  // ...
  const { startServer } = await import('./protocol');
  startServer(p);
```

`__tests__/protocol.test.ts:9` connects with `startServer(port)` and a local
`ws` client, so tests run on loopback and will keep working if the default bind
host is `127.0.0.1`. `zod` is already a dependency (`package.json`).

## Commands you will need

| Purpose   | Command                                         | Expected on success |
|-----------|-------------------------------------------------|---------------------|
| Install   | `npm install`                                   | exit 0              |
| Typecheck | `npx tsc --noEmit`                              | exit 0, no output   |
| Tests     | `npx jest __tests__/protocol.test.ts`           | all pass            |
| CLI tests | `npx jest __tests__/cli.test.ts`                | all pass            |

## Scope

**In scope**:
- `src/protocol.ts` — bind host, origin check, zod param schemas
- `src/cli.ts` — pass through an optional `--host` / bind default (Step 1 only)
- `__tests__/protocol.test.ts` — add origin-rejection and invalid-params tests

**Out of scope** (do NOT touch):
- The browser-automation internals (`createBrowserSession`, `executeBrowserActions`)
  — only validate their inputs, don't change their behavior.
- Adding a full auth/token system — bind-to-loopback + origin check is the
  agreed scope here; a bearer-token scheme is a deliberate follow-up (see
  Maintenance notes), not part of this plan.

## Git workflow

- Branch: `improve/003-harden-websocket-server`
- Commit style: `fix(protocol): bind loopback, validate origin and RPC params`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Bind to loopback by default

Change `startServer` to bind `127.0.0.1` unless an explicit host is provided.
Extend the options:

```ts
export function startServer(
  port: number,
  options?: { sessionTimeout?: number; host?: string; allowedOrigins?: string[] }
): WebSocketServer {
  const host = options?.host ?? '127.0.0.1';
  const wss = new WebSocketServer({ port, host });
  // ...
}
```

Leave the `cli.ts` call as `startServer(p)` (loopback default). Optionally
thread a `--host` option through the `connect` command if the command already
parses options; if not, do not add new CLI flags in this plan.

**Verify**: `npx jest __tests__/protocol.test.ts` → all pass (the test client
connects to `localhost`/`127.0.0.1`, so loopback binding is compatible).

### Step 2: Reject cross-origin WebSocket upgrades

Validate the `Origin` header on connection. Browser-originated connections send
`Origin`; trusted local tooling (the test client, Node clients) sends none.
Reject any connection that presents an `Origin` header not in the allowlist:

```ts
wss.on('connection', (ws, request) => {
  const origin = request.headers.origin;
  const allowed = options?.allowedOrigins ?? [];
  if (origin && !allowed.includes(origin)) {
    ws.close(1008, 'Origin not allowed');
    return;
  }
  // ...existing handler...
});
```

(An absent `Origin` is allowed — non-browser clients. A present-but-unlisted
`Origin` — i.e. a web page — is rejected. This closes CSWSH without breaking
the Node test client.)

**Verify**: add a test (Step 5) that opens a client with
`{ origin: 'http://evil.example' }` and asserts the socket is closed with code
`1008`.

### Step 3: Define zod schemas for RPC params

Add `zod` schemas for each method's params and parse before use. Example:

```ts
import { z } from 'zod';

const ExecuteCommandParams = z.object({ instruction: z.string().min(1) });
const ExecuteBrowserActionParams = z.object({
  instruction: z.string().optional(),
  actions: z.array(z.any()).optional(),
  url: z.string().url().optional(),
});
```

### Step 4: Validate at the dispatch boundary

In each `case`, replace direct destructuring with a `safeParse`. On failure,
return a JSON-RPC error (`code: -32602` "Invalid params") instead of throwing or
proceeding with bad data. For the `url` field specifically, the `z.string().url()`
check already rejects malformed URLs; additionally reject non-`http(s)` schemes
(e.g. `file:`) before passing to navigation:

```ts
case 'executeCommand': {
  const parsed = ExecuteCommandParams.safeParse(req.params);
  if (!parsed.success) { res.error = { code: -32602, message: 'Invalid params' }; break; }
  res.result = translateSync(parsed.data.instruction);
  break;
}
```

For `url`, after parsing, guard the scheme:
`if (url && !/^https?:$/.test(new URL(url).protocol)) { res.error = { code: -32602, message: 'Unsupported URL scheme' }; break; }`

**Verify**: `npx tsc --noEmit` → exit 0.

### Step 5: Add tests

In `__tests__/protocol.test.ts` (model on the existing connect/send tests):
1. **Origin rejection**: connect with a browser-like `Origin` header → socket
   closes with code `1008`.
2. **Invalid params**: send `executeCommand` with `params: {}` (missing
   `instruction`) → response contains `error.code === -32602`.
3. **Rejected URL scheme**: `executeBrowserAction` with `url: 'file:///etc/passwd'`
   → `error.code === -32602` (do not actually navigate).
4. **Happy path unchanged**: an existing valid `executeCommand` still returns a
   `result` (regression guard).

**Verify**: `npx jest __tests__/protocol.test.ts` → all pass, including the new
tests.

## Test plan

- New tests as listed in Step 5, in `__tests__/protocol.test.ts`, modeled on the
  existing test structure in that file.
- Verification: `npx jest __tests__/protocol.test.ts __tests__/cli.test.ts` →
  all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npx tsc --noEmit` exits 0
- [ ] `grep -n "new WebSocketServer({ port })" src/protocol.ts` returns nothing (host is now set)
- [ ] `grep -n "z.object\|safeParse" src/protocol.ts` returns matches (validation present)
- [ ] `npx jest __tests__/protocol.test.ts __tests__/cli.test.ts` → all pass, with ≥3 new protocol tests
- [ ] Only in-scope files modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Binding `127.0.0.1` breaks `__tests__/protocol.test.ts` (the test client uses
  a hostname that doesn't resolve to loopback) — report rather than reverting to
  `0.0.0.0`.
- The existing tests already send an `Origin` header that your allowlist would
  reject (would mean the test harness mimics a browser) — report and propose the
  allowlist entry instead of weakening the check.
- A method's real params shape doesn't match the schema you wrote (the schema is
  a guess from the dispatch code) — read the actual handler, correct the schema,
  and note the deviation.

## Maintenance notes

- This plan intentionally stops at loopback + origin + param validation. If
  `iris connect` ever needs to be reachable off-host, a bearer-token handshake
  (token in the `Sec-WebSocket-Protocol` or an `Authorization` header, compared
  in the `verifyClient`/upgrade hook) is the next layer — do NOT expose it to
  `0.0.0.0` without that.
- A reviewer should confirm no handler proceeds on a failed `safeParse`, and that
  the `file:`/non-http scheme guard runs before any `navigate(page, url)` call.
