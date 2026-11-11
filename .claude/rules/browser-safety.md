---
paths:
  - "src/executor.ts"
  - "src/browser.ts"
  - "src/url-policy*.ts"
  - "src/agent-*.ts"
  - "src/actions.ts"
  - "src/egress-proxy.ts"
  - "src/credential-refs.ts"
  - "src/secret-env.ts"
  - "src/page-timeout.ts"
  - "src/report-encoding.ts"
  - "src/translator.ts"
  - "src/watcher.ts"
  - "src/cli.ts"
  - "src/hosted.ts"
  - "src/visual/reporter.ts"
  - "src/a11y/**"
  - "README.md"
  - "__tests__/{executor,browser,url-policy,runner-url-policy,agent-,policy-every-path,assert-,translator,credential-refs,secret-env,hung-page,cli-run-exit,egress-proxy,report-encoding,readme-run-examples,watch,watcher}*"
---

### Hosted Mode URL Policy (issue #334)

`IRIS_HOSTED` is read once by `isHostedMode()` (src/hosted.ts), memoized, and fails
closed: anything but unset, `''`, `0` or `false` is on. Under it,
`assertNavigationAllowed()` forces `blockPrivateHosts: true, allowFile: false,
allowData: false` over whatever policy its caller passed. The override lives in that one function
on purpose: the navigate action, the per-request CDP guard and the MCP pre-flight
all end up there, so no caller has to remember it and none can relax it. The
page's WebSocket route (`routeWebSocket`, which CDP Fetch cannot see) is installed
with every guard, not only under a pin, and refuses whatever that function refuses. Local
mode is unchanged, and `run` / `watch` have an opt-in `--block-private-hosts`.

- The protocol suite runs under `IRIS_HOSTED=1`, set at the top of the file. Tests
  that need to reach a loopback page go in its "local mode" block, which loads
  its own server through `jest.isolateModules`.
- The switch is memoized per module registry. A test that needs it on or off has
  to read it inside `jest.isolateModules`, or spawn a process with the variable set.
  Setting `process.env` after the first read does nothing.
- The visual and a11y runners install the guard on every page before navigating
  (#335). Visual passes `{}`; a11y passes its `urlPolicy`, or when unset
  `{ allowFile: true, allowData: true }` so the CLI can still scan local files and
  `data:` pages. The MCP tool passes `{}`. Hosted mode overrides all of them.
- Under `jest --coverage`, a *function* passed to `page.evaluate` fails in the
  browser with `cov_* is not defined`. Pass a string expression, as
  `src/visual/capture.ts` does (also for `waitForFunction`), or exclude the module from coverage as the a11y
  modules are.
- **The a11y runner reports the document's URL, read just before axe runs** (#662):
  `guardedDocumentUrl(page, requested)`, not `guardedGoto`'s return value, which is the last
  HTTP response of the navigation asked for and stays the first page when a script, a meta
  refresh or a router moves on. It throws when the page holds Chromium's error page
  (`chrome-error:`, what a refused or failed move leaves behind) or a URL the page's policy
  refuses, in the words of a refused HTTP redirect ("redirects to …, which is blocked by
  navigation policy"), so the MCP tools' fixed reasons apply. Under `IRIS_HOSTED` a move to
  a name the egress proxy refuses is the proxy's 403 document, which `failOnHttpError`
  fails first. Read once: a page that navigates while axe runs fails the scan as before,
  and nothing compares the URL afterwards (a single-page app may rewrite it at any time).
  `guardedGoto` itself is unchanged for the executor, watcher and visual runner.
- Hostnames that *resolve* to private addresses are the egress proxy's job, below.

### URL Guard: Popups, Pins, Opaque Starts (issue #337)

`installUrlPolicyGuard()` now has three layers, and each exists because the others
cannot see something:

- **Page CDP session** — every request of the page, including redirect hops.
- **Context route** — a popup's opening request, which arrives before the popup's
  own session can attach. Playwright continues *redirect hops* inside its own Fetch
  handler (`redirectedFrom` → `Fetch.continueRequest`), so a route never sees them.
- **Browser net** (`browser.newBrowserCDPSession()`, one per Browser) — `Fetch`
  on Document requests of every target plus `Target.setDiscoverTargets`. A popup's
  `targetInfo.openerId` names its opener (the page target, even when a
  cross-origin iframe opened it), so its opening request *and every redirect hop*
  are judged by the opener's live policy (`GuardDecision.attribution: 'opener'`).
  Skipped when `context.browser()` is null; mocked contexts return null for it.

Constraints that are easy to break:

- Do not hold a popup's opening request until the `page` event: the event waits
  for that request, so it deadlocks.
- Live popups per guarded context are capped (`MAX_POPUPS_PER_CONTEXT`). An
  over-cap popup is still registered (so popups opened *through* it find a guarded
  opener and hit the cap too), its requests are refused, and the browser net closes
  it right after refusing its first request. Never `Target.closeTarget` at
  `targetCreated`: closing a target Playwright is still attaching to stalled the
  opening click in 2 of 3 runs. Its guard install also closes it (`page.close()`).
- **The cap is the policy's `maxPopups`** (#379), default `MAX_POPUPS_PER_CONTEXT`; the
  RPC sets it from `ServerLimits.maxPopupsPerSession` (`clampLaunchOptions` puts it on the
  executor's `urlPolicy`). The browser net reads it from the opener's live policy. An
  opener-less page the net marked over the cap is closed at the context's `'page'` event
  (`isOverCap`: a CDP target lookup, skipped while nothing is over the cap): with no URL it
  makes no request to refuse, and with no opener no guard closes it. Not a page count:
  `'page'` events arrive out of creation order, and a count closed a legitimate popup.
  Today Playwright reports the opener even after it closed, or with `noopener`, so that
  branch is the fallback for the race; the test pins the bound.
- A pinned origin now refuses **every** cross-origin request, images and fonts
  included: an image URL is a write channel for a filled-in secret. The explicit
  allowance is `--allow-cross-origin`.
- **`--allow-asset-origin <origin>` (#378, repeatable; `UrlPolicyOptions.assetOrigins`)**
  admits images, fonts, stylesheets, media and scripts from named origins under the pin,
  never a document (top-level or frame), XHR/fetch, beacon or socket. The exemption lives
  in `assertNavigationAllowed(url, policy, resourceType)` (CDP's `Image` or Playwright's
  `image`, lower-cased). The page session and context route pass the request's type; the
  browser net (documents only), `guardedGoto` and the WebSocket route pass none, so an asset
  origin is never a navigation target. An admitted asset URL's query still reaches that
  origin (a GET channel), so list trusted origins only. Values are parsed to exact origins
  at the CLI.
- `runAgentLoop` with pinning on refuses to start from an opaque origin
  (`about:blank`, `data:`), returning `terminationReason: 'error'`, and
  `checkAction` refuses too. Agent-loop tests therefore serve their fixture from a
  local http origin, not a `data:` URL.

### Agent Policy Reads the Resolved Element (issue #353)

The destructive-target check (src/agent-policy.ts) read only the selector string, which can
hide its target. Private backlog item P1.21; the criteria were derived from the code and
listed in the body of the PR that closed #353, for checking against it.

- **CSS escapes are decoded before matching** (`decodeCssEscapes`: hex escapes with their
  optional trailing space, and `\x` for any other character): `#\64 elete-account`
  selects `#delete-account`.
- **`checkResolvedTarget(action, policy, page)`** runs in the agent loop right after
  `checkAction` allows a click or fill. It reads the element the selector resolves to
  (`aria-label`, `title`, `id`, `name`, `value`, `placeholder`, `alt`, text content, matched
  whole) and applies the same destructive-term match. It uses Playwright's
  `getAttribute`/`textContent`, not `locator.evaluate`: a page function would need to be
  a string under `--coverage`, and a string arrow passed to `locator.evaluate` is
  evaluated as an expression that returns the function, never calling it (`undefined`).
- **It fails closed** (codex review): the check waits for the element with the page's own
  action timeout (what the click would wait), so a control rendered late is read, not
  skipped; one that never appears is refused as "not found" (it would have timed out in the
  executor). A read that fails after the element was found (it detached, a read timed out)
  refuses too: a failed read is not an absent attribute. A refusal never ran, so it does
  not clear the goal verdict (#351); a test that
  needs a failing click uses a real but disabled element. The page controls what is read,
  so a hostile page can still label a destructive control blandly; this narrows the
  selector-only gap, it does not close it.
- **Every model-proposed plan runs under it (#354)**: `planPolicy(modelProposed, flags)`
  gives an AI plan (the agent loop, one-shot `iris run` with `translation.method === 'ai'`,
  an RPC `instruction` the AI translated) the agent defaults relaxed by `--allow*` / the RPC
  `policy` param (zod `.strict()`); a plan the caller wrote (pattern translation, explicit
  RPC `actions`) gets only a requested `allow`, or no policy. `checkPlannedAction` (both
  checks) and `pinPage` (request-level pin) are the shared path; `startOriginOf` takes the
  requested URL, then the page, then the plan's first navigation. The RPC applies the
  per-action checks only (`executeUnderPolicy` in protocol.ts): the request-level guard
  would stay on the session's page for later requests. `iris watch --execute` applies it to
  an AI plan: pinned to the origin of `--url` / `IRIS_BASE_URL` (#319; per action and at the
  request layer, `pinPage` before the first navigation), or with the pin off
  when the page is a changed HTML file (`file://` has no origin), so the destructive checks
  remain; `watch` has no `--allow*` flags. A changed non-HTML file with no URL runs nothing,
  decided before translating (no AI spend, no run recorded): it is not a page (#319). Ignore globs match at any depth (`**/` is prefixed) with
  gitignore's `!`: ignored when a pattern matches and no `!` pattern does; with any `!`
  pattern, directories are not pruned (a kept path may lie inside) and files are judged singly. Private
  backlog item P1.22.
- **The action goes to the element that was checked (#530)**: the check reads through one
  `ElementHandle` (`locator.elementHandle()`), returns it as `PolicyVerdict.target`, and
  every caller passes it to `executeAction(action, page, secrets, target)`, which clicks or
  fills that handle and disposes of it. Dispatching by selector re-resolved it, so a page
  could show a disabled benign control to the check and swap a destructive one in before it
  became clickable. A swapped-out handle detaches, and the click fails instead. A test that
  needs a failed read stubs `ElementHandle` reads, not `Locator` ones.

### Retries Never Repeat a Side Effect (issue #296)

`ActionExecutor.executeAction` never retries `click` or `fill` (`mayRepeat` in
src/executor.ts): a failed one may already have reached the page, and repeating it can submit
twice. Nothing is lost: Playwright itself re-resolves a detached element until the timeout
("element was detached from the DOM, retrying"; it throws "Element is not attached to the DOM"
only under `noAutoWaiting`, which IRIS never sets), and real Chromium resolves `page.click`
when the handler throws, the document is replaced or the page navigates to a refused port.
An error that reaches the executor is a timeout, a protocol or target error mid-dispatch, or
unknown. `navigate` (a GET) and asserts keep the general rules (#75: timeouts and policy
verdicts are not retried); retry tests that need a transient failure use `navigate`.

### Assertions Judge a Settled Page and a Parsed URL (issue #504)

`ActionExecutor.performAssert` (src/executor.ts). README has the table.

- **`element_absent`** waits until no request has been in flight for 500 ms (at most
  `ABSENT_SETTLE_MS`, 5 s; a page that never idles is judged as it is), counted by the executor
  from the first action it ran on the page (`trackRequests`, by request identity: one that
  began before tracking cannot cancel out a later one). Not `networkidle`: Playwright
  keeps that lifecycle state, so a page idle before a click read as settled while the click's
  request was in flight (codex review). Then it requires the element to stay absent for
  `ABSENT_WINDOW_MS` (2 s), whatever the action timeout. It used to glance for 1 s, so
  `[click Submit, element_absent .error]` passed before a slow validation request rendered
  the error. Every absence check therefore costs about 2 s.
- **`url_matches`** goes through `urlMatches(url, target)`, never a substring of the href:
  an absolute URL needs the same origin and a path prefix at segment boundaries, `/path`
  the path or below (`/` is the root only), `#route` a hash prefix, `example.com[/path]` the
  hostname or a subdomain, and any other token whole path or hash-route segments. The query
  string never satisfies it. The AI prompts say so.

### Pattern Translator Takes Selectors, Not Prose (issue #297)

`translateWithPatterns` (src/translator.ts) keeps a match only when its target is
something Playwright can use as written; otherwise the instruction falls through to the AI.
It used to pass prose through: `click submit` became `page.click("submit")` (a CSS type
selector no page has), and the watcher's default instruction is `click submit`.

- **Selector targets** (click, fill, `element_absent`): `looksLikeSelector()` accepts an
  engine selector (`text=…`, `role=…`, `css=…`), an XPath, or CSS with at least one token
  carrying selector syntax (`#`, `.x`, `[`, `:x`, `*`, a combinator) and only element names beside it (a known HTML/SVG element or a custom element, #519: `the #name field`, `~50 items` are prose). So `form > button` is a selector, while a bare `button` or `submit`
  is prose (write `css=button`). Quoted, bracket and paren contents are blanked first, so
  `button:has-text("Sign in")` counts as one token.
- **Navigation**: a whitespace-free absolute URL (`URL.canParse`) only, which is all
  `assertNavigationAllowed` accepts anyway; `go to example.com` goes to the AI.
- **No AI configured**: the reply's `reasoning` says no pattern matched and shows the
  forms to use (`click #submit`, …). `error` stays unset: nothing was asked (#294).
- RPC `executeCommand` (`translateSync`, pattern-only) returns `[]` for prose now.
- `__tests__/readme-run-examples.test.ts` reads every `iris run "…"` line of the README
  (not `--agent`). It runs the pattern ones in real Chromium against a local fixture
  (`https://example.com` swapped for it) and checks that the prose ones reach the AI.
  A new README example must work on that fixture or be prose.

### Agent Loop Verdict (issue #351)

`runAgentLoop`'s `goalMet` is the AND of the checks made after the agent's last
*executed* action (success or failure: a failed click may still have been dispatched).
Acting again clears it to `null` until the next check; a policy-refused action never ran
and clears nothing. It used to be the latest asserting turn's checks, so a turn-1 pass
survived seven turns of clicking and `iris run --agent` reported success at `max_turns`.
One-shot `iris run` still ANDs every assert in the plan (plan 013's contract).

### Credential References (issue #352)

A fill's `text` may be `{{secret:NAME}}` (the whole value; NAME `[A-Za-z_][A-Za-z0-9_]{0,63}`).
`src/credential-refs.ts` holds the syntax and sources; the executor resolves it in
`performAction` and nowhere else, so instruction, AI plan, results and history carry the
reference.

- **Sources**: `executeAction(action, page, secrets?)`. Omitted: `IRIS_SECRET_<NAME>` locally
  (CLI, watcher, agent loop), nothing under `IRIS_HOSTED`. The RPC always passes the
  request's `secrets` map (zod-checked names), so it never reads the server's env, local
  mode included. Unknown or embedded (`pw: {{secret:X}}`) references throw
  `CredentialReferenceError`: non-retryable, message names the reference only.
- **Two leaks Playwright creates, both probed**: a failed `page.fill` error quotes the value
  in its call log (`- fill("…")`), so the fill case cuts the typed value (literal ones too)
  from the error; and `ariaSnapshot()` shows field values, password inputs included, so the
  agent loop's digest goes through `executor.redactSecrets()` (values this executor resolved
  from references) before the model sees it.
- No org vault: hosted fills arrive over the RPC from a client that holds its credentials. A
  vault would be one more `SecretSource`. `IRIS_SECRET_*` is scrubbed by `jest.setup.ts`.
- **Hardening (#513)**:
  - **Origin binding**: a source may return `{ value, origin }`
    (`IRIS_SECRET_ORIGIN_<NAME>` locally; an RPC `secrets` entry `{ value, origin }`, zod-checked
    URL). A reference fill resolves its element first (`fillFromReference`: the policy's handle,
    else the selector's own `elementHandle`, frame-entry selectors included) and
    `resolveFillText(text, source, pageOrigin)` refuses a bound reference unless that element's
    document has exactly that http(s) origin (`effectiveOrigin`): the frame URL's origin (the
    browser's) and `self.origin` (catches a sandboxed iframe, opaque `null` whatever its URL;
    writable by page script) must both equal it. An unknown or opaque origin is refused. Not
    refused: a sandboxed document *served by the bound origin* whose own script redefines
    `self.origin`. Only the bound site can do that (a parent cannot script into an opaque
    frame; `srcdoc`/`data:`/another site's `blob:` fail the URL check), and its own script can
    already read its fields; a browser-side origin (CDP isolated world) would cost a CDP
    session per fill for no change in who reads the value (codex review, rejected 3x). The value is
    typed into that same element. A malformed env binding (empty included) fails the fill,
    never unbinds it. The selector's handle is strict like `page.fill`: two matches refuse.
  - **Redaction by element**: the executor keeps the handle of each field it filled from a
    reference (a policy handle is retained, not disposed after the action; at most 50, the
    oldest released first; released when the page closes, when a read finds the field gone,
    and at `cleanup()`: handles kept into closed pages made `browser.close()` take tens of
    seconds or hang) and
    `refreshFieldValues()` re-reads what they hold, so `redactSecrets` also cuts a
    `maxlength` prefix or a page rewrite of the value. The agent loop and RPC `observe` call it
    before reading the page. Values under 4 characters read back are not cut. Values read are
    kept for the executor's life (a later read that times out must not un-redact one), and the
    screenshot mask (`secretFields`) matches them too, so a truncated field is masked.
  - **Short values**: under `MIN_SECRET_LENGTH` (4) a reference is refused at fill time,
    naming the reference only: cutting a 1-3 character value would cut every match of it
    from errors and digests. A short non-secret value is filled literally.

### Hung Pages and Provider Failures (issue #293)

- **`AITranslationResponse.error`** is set by the text clients when the provider could
  not be asked or its reply could not be read (unreachable, HTTP error, not JSON, empty).
  `actions` is then empty. A reply that parsed but proposed no or schema-invalid actions
  is a plan, not a failure, and leaves it unset. `runAgentLoop` ends `error` on it at
  once; it used to retry it as an empty plan and report `no_actions`. `translate()`
  carries it as `TranslationResult.error` (#294), also set when the client is unavailable
  or throws; no AI configured / no tenant credentials stays a plain empty plan. The RPC
  reply returns the whole `TranslationResult`, so on IRIS's managed key `error` gets the
  same rewrite as `reasoning` (#479). `iris watch` logs it (`❌ AI translation failed: <reason>`) and records the run as an error (#511).

### `iris run` Exit Codes (issue #294)

- `0` success, `1` failure (`status: "error"`: failed action, unmet goal, no actions), `2`
  usage (`--agent` without a URL, `--agent --dry-run`), `3` a provider outage (#510): one-shot
  when `translation.error` is set, `--agent` when `AgentRunResult.errorKind` is `provider`
  (client setup threw, a turn's call threw or carried `error`; `other` is a refusal before
  any AI call: opaque start origin, no org credentials, an AI that is not configured, IRIS's
  own budget breaker) and the loop dispatched nothing: after a click, 3's "retry is safe"
  would repeat it (#296). `translate()` leaves `error` unset for `BudgetExceededError`, so
  one-shot matches. The JSON `agent` carries `errorKind`.
  Commander's own usage errors exit 2 too (#496): `program.exitOverride` maps every commander
  error with a non-zero code to `EXIT_USAGE`; help and `--version` keep 0. It is set before
  any `.command()`, which copies it to each subcommand.
- **Set through `process.exitCode`, never `process.exit()`**: the `--json` payload is the
  last `console.log`, and on a pipe stdout is async, so `exit()` can truncate it.
- In-process `runCli()` tests set `exitCode` on the Jest process; `jest.setup.ts` resets
  it after every test, or a leftover `1` fails a `--runInBand` run whose tests all passed.
  `cli-run-exit.test.ts` spawns the real CLI to prove the code reaches the OS.
- **`page.title()`, `page.evaluate()` and `page.addStyleTag()` take no timeout** and wait
  forever on a page spinning its main thread. Go through `src/page-timeout.ts`:
  `withPageTimeout(call, fallback, ms)` (2 s default; a rejection still rejects) or
  `addStyleTagBounded()` (throws on timeout: a capture without its mask would show what
  the mask hides). Locator calls, screenshots and `waitForFunction` have their own.
- **The a11y runner has one deadline per page** (`pageTimeoutMs`, default
  `A11Y_PAGE_TIMEOUT_MS` = 120 s) instead of bounding its ~20 `evaluate` sites: a hang is
  not a throw, so #287's page isolation never fired. The hung page is abandoned, and its
  context (with the spinning renderer) is closed before the next page starts, bounded at 5 s
  (#508); one opened after the deadline closes itself. The next page gets a fresh context.
- Tests: `__tests__/hung-page.test.ts` (real Chromium, `setTimeout(() => { for (;;) {} })`,
  with a positive control that the page really is hung). Closing a context whose renderer
  spins can take seconds under load, hence the 15 s `afterEach`.

### Hosted Egress Proxy (issue #336)

Under `IRIS_HOSTED`, `launchBrowser()` points Chromium at an in-process HTTP/CONNECT
proxy (`src/egress-proxy.ts`, one per process, started on first launch). It is the
only layer that sees worker and SharedWorker requests, and the only one that sees
resolved addresses: it resolves the target once, refuses it (403) if **any** answer
is private, reserved or metadata (`isBlockedAddress()`, the same range tables), and
dials the address it vetted, so a rebinding resolver gets no second lookup.

- `bypass: '<-loopback>'` is passed explicitly. Chromium sends loopback direct past
  any proxy unless told otherwise; Playwright adds the rule itself but drops it when
  `PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK` is set.
- `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`: UDP cannot be proxied,
  and STUN to an internal host:port otherwise goes straight out.
- **Bounded (#379)**: a lookup (`lookupTimeoutMs`, 10 s), the upstream connect
  (`connectTimeoutMs`, 10 s) and an upstream connection with no traffic either way
  (`idleTimeoutMs`, 5 min) end with a 504. `dial()` destroys the socket with a `Refusal`;
  the forward path reports `socket.errored`, since `http.request` says only "socket hang
  up". Tests fake a black hole with `Object.assign(new net.Socket(), { connecting: true })`:
  a never-connected socket rejects writes at once, and a real TEST-NET address is dropped
  on one network and unreachable at once on another. The "502 when the vetted address
  refuses" test dials a port it bound and closed, not 127.0.0.1:1, which blackholes on WSL
  (#382).
- Tests substitute DNS and dialing through `hostedEgressProxy({ lookup, connect })`,
  called before the first launch in the registry. `connect` sends the one "public"
  test address (`8.8.8.8`) to a local server, so every refusal has a positive control
  that goes through the same proxy. A refused target must leave no hit on the server.
- **QUIC is off under the fixed proxy (#375)**: no WebTransport session and no HTTP/3
  fetch sends a UDP datagram in hosted mode, even with `--origin-to-force-quic-on`; local
  mode sends them (the negative controls). So no `--disable-quic` is added. The probes
  switch off Chromium's local-network checks (in both modes), which otherwise refuse a
  public page's connection to loopback and made the first probe send nothing either way;
  a test appends such switches by wrapping the isolated registry's `chromium.launch`.
- Not covered: a container-level egress firewall, and names Chromium resolves for DNS
  prefetch (a lookup, no connection).

### Report Output Encoding (issue #339)

Every report field that is not a number may hold text the page under test
controls: page names, axe output (axe runs *inside* the page) and model output
quoting the page. Both report writers route every interpolation through
`src/report-encoding.ts`; do not add a local escaper.

- **XML**: characters XML 1.0 forbids (C0 controls, lone surrogates, U+FFFE/FFFF)
  have no escape; `escapeXml` replaces them with U+FFFD. TAB/LF/CR go out as
  character references so attribute values keep them.
- **Markdown**: inline punctuation is backslash-escaped and newlines fold, but a
  value placed after a list marker still starts a block, so leading whitespace is
  dropped and a leading `-`, `+`, `1.` is escaped. Bare URLs may still autolink
  under GFM; the target is then the visible text.
- **Links**: `safeHref()` allows http(s) only. Attribute escaping does not make a
  `javascript:` URL inert.
- **Tests** assert *structure equivalence*: one report rendered with benign and
  with hostile strings must parse (Chromium DOMParser, markdown-it) to the same
  element/token sequence. Substring checks pass on half-escaped documents.
- Writing `\u....` escapes through a tool call can land as the raw character on
  disk. Check with `cat -A` when editing a regex or fixture that uses them.
