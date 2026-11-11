---
paths:
  - "src/protocol.ts"
  - "src/log.ts"
  - "src/metrics.ts"
  - "src/api-key-auth.ts"
  - "src/hosted.ts"
  - "src/cli.ts"
  - "src/mcp/**"
  - "deploy/watchdog.sh"
  - "docker/healthcheck.js"
  - "__tests__/{protocol,observability,graceful-shutdown,session-lifecycle,api-key-auth,watchdog-script,hosted-dotenv}*"
---

### Observability (issue #275)

`src/log.ts` and `src/metrics.ts`, no dependencies. Ops side: runbook "Monitoring and
alerts".

- **Logs go to stderr, always** (`console.error`): JSON in hosted mode, `[iris] msg
  k=v` locally. stdout is program output; `api-key-auth.test.ts`'s probe parses its
  stdout as JSON, and a log line there broke it. Level from `IRIS_LOG_LEVEL`, read per
  call; default `info` hosted, `warn` locally (local `iris connect` prints no request
  lines). Tests spy `console.error`; the variable is on the `jest.setup.ts` scrub list.
- **Never pass a secret.** Log `keyId`, never the key; action *types* (from the results),
  never selectors or `text`. `redact()` is a net, not the rule: secret-named fields (incl.
  `text`/`value`/`instruction`/`params`/`body`), and in strings (error messages too) URL
  userinfo, `Bearer`/`Basic …`, secret-looking query params (`?token=`, `sig`, `auth`…)
  and `iris_<16+ alnum>` keys. Errors are logged as their message only.
- **Modules shared with the local CLI** (translator, AI clients, cost tracker, usage
  ledger, Postgres pool) print through `hostedLog(level, msg, fields, () => console…)`:
  JSON hosted, their old console output locally. `observability.test.ts` fails on a bare
  `console.*` in those files.
- **Logging is synchronous**, so request lines add no await ahead of the SessionGate
  (#128). The RPC line is written after `reply()`; the REST line on `res` `'close'` (a
  test reads it ~50 ms after the response). Once the server has closed, request lines
  are counted but not printed ("Cannot log after tests are done").
- **Pre-dispatch refusals are throttled per connection** (rate-limited, unparseable,
  not-a-request): one line per 10 s carrying `suppressed`, a summary on close; every one
  is still counted. They cost a client nothing, so unthrottled they flushed the logs.
- **REST `requestId` is always ours** (also the `X-Request-Id` header); a safe client
  `X-Request-Id` is logged as `clientRequestId` only (it could collide).
- **Bounded labels only**: RPC method from a fixed set (else `unknown`), REST route with
  the id folded (`GET /v1/jobs/:id`), outcome `ok|client_error|rate_limited|error`. No
  org id on any series; `usage_events` is the per-org record. `-32600/-32601/-32602`
  and tenant-caused `-32000`s (thrown with `refused: true`: no session, session limits,
  closed during launch) are `client_error`; other codes are `error`. `executeBrowserAction`
  answers every failure as `{ success: false, error }`; its outcome rides beside the reply
  in a `WeakMap` (`tagged()`): a throw caught there (launch, page, dead browser,
  translation) is `error`, missing instruction/actions `client_error`, a failed action
  `ok`. A REST response the
  client abandoned is `aborted`. The watchdog's rate is error / (ok + error), so no tenant
  can raise or dilute it.
- **One process-wide registry** (`metrics`). `startServer` re-registers its gauges
  (sessions, browsers) on each call, so with several servers in one process the last
  wins. `iris_errors_total` counts every `log('error', …)` call, printed or not.
- **AI spend** is counted in the translate `onUsage` callback, which is now attached for
  every tenant request, ledger or not (`protocol-auth.test.ts` asserts it).
- **The metrics listener refuses non-loopback hosts**, so in a container it is reachable
  only from inside it (a published port reaches the container's interface, #192). That is
  why compose publishes nothing for 9464/9465 and the watchdog scrapes with `docker exec
  <c> node -e fetch(...)`. Do not "fix" it by binding 0.0.0.0.
- **BetterAuth's logger** is pinned in `createAuth()` (`logger` is omitted from its
  options type): an `APIError` with `INVALID_API_KEY`, `KEY_NOT_FOUND`, `KEY_DISABLED`,
  `KEY_EXPIRED` or `USAGE_EXCEEDED` drops to info; anything else stays at its level. Only
  string and error-message arguments are logged (BetterAuth may pass rows).
- **Watchdog** (`deploy/watchdog.sh`, root timer every minute, installed like the backup):
  restarts `unhealthy` containers (Docker never does; `unless-stopped` acts on exit only),
  capped per service per hour; alerts on Docker's own restarts (`RestartCount` up), failed
  scrapes and the error share over a 5-minute window (samples in `/var/lib/iris-watchdog`
  with `iris_start_time_seconds`; a new start time or counters below the *latest* sample
  restart the window; times after now are dropped, so a clock stepping back neither
  counts nor suppresses). Container text in alerts is cut to one printable line (300).
  A container gone between `ps` and `inspect` is skipped (`|| continue`, `set -e`). Alerts: `logger -p crit -t iris-watchdog`
  plus `/etc/iris/alert-hook <key> <message>`, repeated per key only after
  `WATCHDOG_ALERT_REPEAT`. `container-config.test.ts` checks the script's default targets
  against the compose `--metrics-port` values.
- **`watchdog-script.test.ts`** runs `node:24-alpine` containers with compose labels; a
  healthcheck on `/tmp/sick` makes one unhealthy on demand, and the file survives a
  restart, which is how the cap is reached. `logger` and the hook are PATH/file stubs.
  ~90 s on a loaded WSL daemon.

### `iris connect` Startup Configuration (issue #358)

Private backlog item P1.26; criteria derived from the code and #358's comments (its
database item was delivered by #341: hosted startup exits 3 without `DATABASE_URL(_FILE)`).

- **Hosted mode never reads `.env`.** `runCli()` calls `loadDotenv()` only when
  `isHostedMode()` is off. Hosted configuration is the deploy's environment and `_FILE`
  secrets; a stray `.env` in the image or working directory supplied unset credentials.
  IRIS_HOSTED is read before any `.env`, so a `.env` cannot switch hosted mode on or off.
  Tested by a spawned hosted `connect` (`hosted-dotenv.test.ts`): the token only in `.env`
  reaches the database check (exit 3); the same token from the environment is refused (2).
- **Warnings, not refusals** (`warnStartupConfig`): hosted-only flags (`--rate-per-key`,
  `--rate-per-org`, `--max-sessions-per-org`, `--max-connections-per-org`) given outside
  hosted mode do nothing (no principal, #342), and a supplied shared token under 32
  characters is weak. Refusing either would break existing setups whose tokens are secrets
  the check cannot see; the token is never printed.

### Graceful Shutdown and Readiness (issue #309)

- **`GET /health/live` and `GET /health/ready`** on the `iris connect` listener, answered
  before auth, logging and the job routes: probes run every few seconds, and hosted mode has
  no shared token to authenticate a probe with (#341). Live is 200 while the process serves;
  ready is 503 while draining. Production's compose healthcheck probes readiness (it used to
  infer health from `GET /` answering 404).
- **SIGTERM drains** (`drainServer(wss, ms)`, src/protocol.ts): readiness turns 503, new
  upgrades get 503 (re-checked after an async key check), new REST requests 503 (no job is
  queued during shutdown), new requests on open sockets `-32000 Server is shutting down`, and it
  resolves once every message in flight has been answered (a counter around the message
  handler), or at the deadline (`DRAIN_DEADLINE_MS` = 12 s in cli.ts). Then the sockets
  close and the sessions' browsers with them; 5 s later a forced exit. `stop_grace_period`
  (20 s) must exceed both; `container-config.test.ts` reads the constant. A second signal
  exits at once.
- **`iris-mcp` exits on SIGTERM, SIGINT and stdin EOF** (the SDK does neither), closing the
  server with a 2 s cap; Playwright closes its browsers on exit.
- Tests: `graceful-shutdown.test.ts` (in process, and real processes for `iris connect` and
  `iris-mcp`). A test that runs `iris connect`'s SIGINT handler with a mocked server must let
  the drain's promise settle before asserting.

### MCP Tool Output and Limits (issue #362)

Private backlog item P2.2; the checklist is in #362's comments. A tool result is read by a
model, and the page under test chooses much of what an error or a redirect contains.

- **Hints**: `readOnlyHint: false, destructiveHint: true, idempotentHint: false,
  openWorldHint: true`. The tool drives a real browser to a model-chosen URL and cannot
  promise the visit changes nothing. Do not set `readOnlyHint` back to make a client stop
  asking.
- **Failures carry a reason from a fixed vocabulary** (`scanFailureReason`,
  src/mcp/scan-errors.ts): policy block by address kind, redirect to a blocked address (the
  target is never named), a `net::ERR_*` code (only at the start of Playwright's message, at most 60 characters),
  timeout, a browser that could not launch, else "could not be completed". The address kind is read after the last
  "blocked by navigation policy", never from the refused URL before it. It
  matches on the guard's and Playwright's message text, so a reworded `guardedGoto` error
  degrades to the generic reason; `scan-errors.test.ts` pins the shapes. The raw first line
  goes to stderr (`log('warn', 'mcp scan failed')`). A new failure mode worth telling the
  caller about is a new branch there, never a pass-through.
- **The request URL is repeated through `withoutCredentials()`**, which parses it: a
  password may hold a space or an `@`, which no pattern over free text can follow (codex
  review, twice). A URL that does not parse is never quoted back ("malformed URL.").
- **`scannedPage(requested, scanned)`**: same URL reports the request without userinfo; a
  redirect reports `redirected: true` and origin plus path, at most 200 characters, path
  segments of 32+ characters cut to `…` (tokens; shorter ones show). "Same" is compared as
  parsed `href`s without fragment and userinfo: the runner's URL is the response's, which
  has neither, so `/#/route` read as a redirect (internal review).
- `stripUserinfo` (src/report-encoding.ts) and `redactString` (src/log.ts) are patterns over
  free text. Since #645 both cut to the **last** `@` of the authority (`[^\s/?#]*@`: `/`, `?`
  and `#` end it, so an `@` in a path or query stays), as a URL parser does. **Whitespace
  still ends the match**: in prose a space ends a URL, so a password holding a raw space
  (`http://u:correct horse@host/`) is not followed, and that is decided, not an oversight
  (reading on to a later `@` would eat `see http://host and mail a@b`). So: a URL you hold
  whole goes through `urlWithoutUserinfo()` (parsed; text that does not parse gets the
  pattern), and text known to quote one goes through `stripUserinfo(text, quotedUrl)`,
  which replaces each occurrence by its parsed form before the pattern runs (a11y page
  errors with the page, stored RPC errors with the navigation target; `loggedDetail` does
  the same for the MCP log). A space written `%20` has no such problem. Tests:
  `url-credentials.test.ts` (no browser).
- **`ScanLimiter(2, 8)`** (src/mcp/scan-limiter.ts), one per process: 2 scans run, 8 wait in
  arrival order, the next is a tool error at once. A finishing scan hands its slot to the
  head of the queue. Stdio only: hosted MCP (#314) does not use it, its cap is the org's
  `maxQueuedJobsPerOrg`. A cancelled call that is already waiting still runs.
- Tests: `scan-errors.test.ts` and `scan-limiter.test.ts` need no browser;
  `mcp/tools.test.ts` shows each item through a real scan (the cap with a fixture that
  holds its responses and counts them; its wait loops are bounded by poll count, since an
  unbounded one outlives the test's timeout and hangs Jest).

### Hosted MCP over HTTP (issue #314)

`POST /v1/mcp` on the hosted `iris connect` listener (`src/mcp/hosted.ts`), routed in
`startServer` beside the job API whenever `jobs` is set. README has the client view.

- **A tool call is an a11y job.** `run_accessibility_test` enqueues `{ urls: [url], wcagLevel,
  failOn: all four }` through the caller's `jobs.forOrg(scope)` and polls `get(id)`. The
  worker does the scan, the history row and the `a11y_job` usage row (#267); this module
  drives no browser and writes no usage. Do not add a second path to a browser here.
- **Auth is `authorize()`** (src/jobs-api.ts), the step the job API uses: verify slot, key,
  suspension 403, key and org buckets. One HTTP request is one rate token.
- **Stateless**: a new `McpServer` and transport per request (`sessionIdGenerator:
  undefined`, `enableJsonResponse: true`). Only POST; GET/DELETE are 405. An array body is
  refused (`-32600`): a batch would start several scans for one token (#528).
- **The wait is `ServerLimits.mcpScanWaitMs`** (45 s), below the ingress's 75 s
  `proxy_read_timeout` for `/v1/`. Past it the call answers `{ jobId, status }` (not an
  error) and `get_accessibility_test_result` reads the job later. Raise the ingress
  timeout before raising the wait.
- **A caller that goes away withdraws its queued job** (`res` `'close'` aborts the wait;
  `OrgJobs.cancel(id)` deletes a row still `queued` and audits `job.cancel`). A job a
  worker has claimed runs and is billed. A drain that closes the socket does the same.
  The row is deleted, not set to `canceled`: a finished run with no start time would
  appear in history, and one with no finish time would never be purged by retention.
- **What a result may say**: a failed job's stored `error` is page-influenced text and
  goes through `scanFailureReason` (the worker's own `ORG_SUSPENDED` and `JOB_TIMED_OUT`
  are worded here); the raw text is logged (`mcp scan failed`). Findings come from the
  stored page result: `violationRules` (rule id, impact, node count, at most 50, written
  by `resultsOf` since #314; rows from before have counts only, so `violations` is empty
  beside a non-zero `violationCount`), `needsReviewRules`, `keyboardPassed`.
- **`passed` is the stored page verdict** with every impact in `failOn`: no violation and
  the keyboard checks passed. #646 (what `passed` means for the stdio tool) is still open.
- **The URL pre-flight** refuses non-http(s), credentials (params are stored and org-readable)
  and what `assertNavigationAllowed` refuses, before `enqueue`, so it costs no run. A name
  that resolves to a private address still fails in the worker, at the egress proxy.
- `src/mcp/hosted.ts` must not import `./tools` or `./server`: they load the a11y runner
  into the API process. `packageVersion()` lives in `./version` for that reason.
- Tests: `mcp/hosted-http.test.ts` (SDK client over real sockets, in-memory job store, the
  test plays the worker; sets `IRIS_HOSTED` at the top so the pre-flight is the hosted
  policy) and `hosted-mcp-job.test.ts` (real Postgres, worker and Chromium).

### RPC Server Error Policy (issue #330)

`iris connect` installs `installProcessErrorPolicy()` (src/protocol.ts), and the
split is deliberate:

- **Unhandled rejection → log and keep serving.** Rejections come from per-request
  async work. Node's default (crash) is how one malformed frame used to end every
  client's session.
- **Uncaught exception → log and exit 1.** A synchronous throw that escaped every
  handler leaves shared state unknown. Playwright kills its browsers on exit.

Two rules keep the server alive under hostile input. Validate a frame's *shape*
before reading from it: `null`, `1`, `[]` and `"x"` are all valid JSON, and get
`-32600` with `id: null`. And send only through `reply()`, which checks
`readyState`. `connect` announces "listening" only after the `listening` event;
a taken port exits 3.

Test it out of process. Jest absorbs an unhandled rejection, so an in-process
test passes against the very crash it is meant to catch.
`protocol-robustness.test.ts` spawns `src/cli.ts` through ts-node
(transpile-only) rather than `dist/`, so it never races the MCP suite's `tsc`.

### JSON-RPC 2.0 Compliance (issue #357)

`iris connect`'s frame handling (src/protocol.ts) follows the spec. Private backlog item
P1.25; criteria derived from the spec and #357's comments.

- **Parse error** -> `-32700`, id null (it used to be dropped; still charged first, #342).
- **Invalid Request** -> `-32600`: `jsonrpc` must be `"2.0"`, `method` a string, `id` (when
  present) a string, number or null. The id is echoed only when it is one of those.
- **Notifications** (no `id` member) run and get **no reply**, error or not, a `-32029` rate
  refusal included (it is still charged and logged). A test request
  without an `id` is therefore never answered: give every test request an id.
- **`toRpcError(thrown)`**: a thrown value with an integer `code` and string `message` keeps
  them (the server's own `{ code: -32000, … }` refusals, `-32029`). Anything else, including
  a Node error whose `code` is a string, is `-32603 Internal error` with no detail; the
  message goes to the log (`rpc handler failed`).
- **`serializeResponse`**: a result `JSON.stringify` cannot handle becomes a `-32603` frame
  for the same id instead of silence.
- **Batches are not supported (#528, decided)**: an array is one `-32600` with `data`
  "Batch requests are not supported", and none of its elements runs; the reasons are in
  docs/integration-surfaces.md.
- **A synchronous method stays synchronous (#518).** Handlers live in a `methods` table
  (`Object.hasOwn` lookup); `dispatch` returns a plain boolean when the handler returned no
  promise (`getStatus`, `executeCommand`), so `reply()` runs before ws emits the next frame
  of the same chunk. An awaited dispatch let a later frame's synchronous refusal (rate,
  shape) overtake the earlier reply; `protocol-auth`'s "malformed object without an id"
  test pins the order.

### RPC Server Limits (issue #338)

`startServer(port, { limits })` takes any subset of `ServerLimits`; the rest come
from `DEFAULT_SERVER_LIMITS` (src/protocol.ts). `iris connect` exposes the four an
operator sizes a box by: `--max-payload`, `--max-connections`, `--max-sessions`,
`--max-actions`.

- **Origin, token and the connection cap run in `verifyClient`**, before the
  upgrade. A refused client gets HTTP 403 / 401 / 503 and never becomes a
  `wss.clients` entry. It used to be accepted and closed with `1008`. A test for a
  refusal listens for `unexpected-response`. Calling `terminate()` there emits
  `error`, so the test needs an error listener too.
- **`maxSessions` is server-wide.** A connection has at most one session (launch
  replaces it). Each connection has its own `SessionGate`, so the gate does not
  order the shared map. The cap's check and `sessions.set` must stay free of
  awaits between them, which is why `createBrowserSession` is synchronous.
- **Timings are clamped, not rejected.** Omitted values are filled from
  `EXECUTOR_DEFAULTS` (src/executor.ts) first, so an operator ceiling below a
  default still applies. A `jest.mock('../src/executor')` that loads the protocol
  must re-export `EXECUTOR_DEFAULTS` (see `protocol-leaks.test.ts`).
- **Heartbeat tests use `autoPong: false`** on the client, which makes a half-open
  peer as the server sees it.
- **Work can outlive its socket.** A queued `launchBrowser` or an in-flight action
  can resume after the socket's `'close'` cleanup has run. So launch refuses to
  insert unless the socket is `OPEN`, and an action refuses to create a page once
  `cleanupSession` has cleared `session.isActive`. Without those, the first leaves
  a phantom session holding a `maxSessions` slot for 30 minutes, and the second
  launches a Chromium nothing reclaims. Tests hold the fake Ollama answer to open
  that window on demand.

### Hosted RPC Authentication (issue #341)

Under `IRIS_HOSTED`, `iris connect` authenticates **org API keys**
(`Authorization: Bearer iris_…`) through `startServer({ authenticate })`, and the shared
`IRIS_CONNECT_TOKEN(_FILE)` is refused at startup (exit 2), not ignored. Missing
`BETTER_AUTH_SECRET` / `BETTER_AUTH_URL` / `DATABASE_URL(_FILE)` exits 3.
`hostedServices()` (src/api-key-auth.ts) builds the shared `createAuth()` over
Kysely and calls `verifyApiKey`; the key's `referenceId` is the org.

- **`verifyApiKey` cannot tell a backend failure from a bad key.** The plugin catches
  every error (timeout, locked table, its write on a read-only database) and returns
  `valid: false, code: INVALID_API_KEY` either way. So a refusal is believed only when
  `keyIsUsable()`, a read-only lookup of the key's row by the plugin's own
  `defaultKeyHasher`, agrees it is gone, disabled, expired or used up. Otherwise the
  authenticator throws: `503` at the upgrade, "keep the connection" at a re-check. A
  `select 1` is not enough: it succeeds while the `apikey` table is locked.
- **The auth pool has a query timeout** (`createPostgresDb(url, { queryTimeoutMs })`):
  a stalled query would otherwise hold an upgrade slot and stall every later re-check.
  Migrations keep the unbounded default. Hosted startup probes the database (exit 3).
- **The check is async inside `verifyClient`.** Upgrades still being verified count
  against `maxConnections` (`verifying`), or a burst of slow checks would all be
  admitted. Decrement right before `done()`: ws adds the client synchronously.
- **Revocation ends live connections** on a timer (`authRecheckMs`, default 60 s),
  closing with `1008` and reclaiming the browser at once. Not per message: an await
  ahead of the `SessionGate` would reorder pipelined messages (#128). The re-check is
  `Authenticator.recheck(principal)`: a read-only lookup by key id and org
  (`postgresKeyStore().isLive`), because `verifyApiKey` writes `lastRequest` and spends
  `remaining` on every call. A connection keeps no plaintext key (#342).
- The principal rides on the connection and its `BrowserSession`. Hosted `getStatus`
  counts only the caller's org sessions.

### Tenant Limits (issue #342)

`ServerLimits` gained four hosted-only limits: `keyRequestsPerMinute` (120),
`orgRequestsPerMinute` (300), `maxSessionsPerOrg` (2), `maxConnectionsPerOrg` (8).
They apply only to connections with a principal; local mode is untouched.

- **Rate limits are token buckets keyed by key id and org id** (`RateBuckets` in
  src/protocol.ts), checked synchronously before dispatch, not after an await (#128).
  Both buckets must have a token before either is spent. A refused request gets
  `-32029` with `data.retryAfterMs` and never runs. Buckets outlive connections, so
  reconnecting gains nothing; full buckets are pruned on the heartbeat. In memory, one
  process (#316 for several).
- **The per-org connection cap is checked in the async `verify` callback**, against
  `tenants`. That is safe only because ws emits `'connection'` synchronously inside
  `done(true)` and the handler registers the tenant before returning.
- **The api-key plugin's own limiter stays off for good.** It limits verifications,
  not requests, and every key row created so far has `rateLimitEnabled = false`, so
  turning it on would need a backfill migration (#340 comment). No backfill is needed.
- **The healthcheck probe slot**: a loopback peer sending `X-Iris-Probe: 1` gets one
  connection beyond `maxConnections`. Loopback only: a published port arrives on the
  container's interface. The test reaches the server through the host's own interface
  address to prove a remote header gets no slot. It serves the token-mode deployment
  (staging); the healthcheck cannot authenticate in hosted mode at all yet (#309).
- **Buckets run on `performance.now()`**, not `Date.now()`: the WSL2 clock steps
  backward (#190), and a negative elapsed time would drain a budget. A malformed frame
  from a tenant spends a token too (the check runs before the shape check).
- Per-IP pre-auth throttling is the ingress's `limit_req` (#347), not the server's:
  behind the proxy every peer is loopback.
- `startServer` itself does not enforce hosted mode: `protocol.test.ts` runs under
  `IRIS_HOSTED=1` with a token or no auth. `iris connect` is the enforcing caller.
- Tests: `protocol-auth.test.ts` (seam, in-test key table) and `api-key-auth.test.ts`
  (real Postgres, spawned hosted `iris connect`, keys made through BetterAuth).

### RPC `observe` (issue #312)

The network client's eyes: `observe` (params `{ screenshot?: boolean }`, `.strict()`) answers
`{ snapshot, screenshot? | screenshotOmitted? }` for the session's page (`observeSession` in
src/protocol.ts).

- **`snapshot` is `observePage()`'s digest**, the one the agent loop plans against (URL, title,
  ARIA snapshot, capped at `MAX_DIGEST_CHARS`), with `executor.redactSecrets()` applied before
  the cap.
- **The screenshot is a viewport JPEG (quality 70), base64**, with every field holding a value
  typed from a `{{secret:NAME}}` reference masked (`executor.secretFields(page)`: the first 100
  `input`/`textarea`/contenteditable elements, in every frame, whose value contains one; a field that cannot
  be read is masked too, and so is every field past the 100th, unread). Fields that cannot
  be listed (a hung page) mean no screenshot (`screenshotOmitted`), never an unmasked one; a
  screenshot that throws keeps the snapshot. The session is `busy` while observed (#240). `observe` runs under the gate's exclusive side (`gate.write`), so
  no fill can land between choosing the mask and the capture (codex review). Over
  `MAX_OBSERVE_SCREENSHOT_BYTES` (1 MiB) it is left out with `screenshotOmitted`.
- **No page yet is a refusal** (`-32000`): observing never launches a browser.
- **Metered**: one `observation` usage row per call for a tenant connection (platform usage:
  no billing mode, no unit cost), best effort like browser minutes. Nothing is stored: the
  screenshot goes to the client only.

### Browser Session Lifecycle (issue #240)

- **`ActionExecutor.cleanup()` waits for an in-flight launch**, then closes what
  it yields. A cleanup that landed mid-launch used to find no browser yet; if
  page creation then failed, that Chromium ran with nothing to close it.
- **Concurrent `createPage()` calls share one launch (#383).** `launchBrowser()` returns
  the in-flight `launching` promise first; two callers each used to start a Chromium, and
  the first one's process was never closed.
- **A dead browser is dropped, not reused.** The executor clears it on
  `disconnected`, and the protocol clears a `session.page` that `isClosed()`,
  so the next action relaunches. Playwright notices a kill ~100ms after the
  process is gone; a request in that window gets "browser has been closed".
- **`session.busy` counts in-flight requests.** The sweeper skips a busy session,
  and `lastActivity` is refreshed when a request ends, not only when it starts.
  The sweep runs every `min(5 min, sessionTimeout)`.
- **`cleanupSession` deletes only its own map entry**: a launch may have replaced
  it during the await.
- **`isVisible` returns false only on `TimeoutError`.** Anything else (closed
  page, bad selector) is an error, so `element_absent` cannot pass on a dead page.
- ws `close`/`error` stay outside the `SessionGate` on purpose: the gate would
  make a dead client's browser wait for in-flight actions before being reclaimed.
- Chromium `close()` takes 1.4-1.9s on a loaded dev host. Process-exit waits in
  tests get a long poll budget; an orphan never exits, so it costs no signal.
