# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

IRIS (Interface Recognition & Interaction Suite) is an AI-powered UI understanding and testing toolkit under active development. The project gives AI coding assistants "eyes and hands" to see and interact with user interfaces through natural language commands.

## Development Commands

```bash
# Build the TypeScript source
npm run build

# Run tests
npm run test

# Quality gates (also enforced in CI)
npm run typecheck      # tsc --noEmit
npm run lint           # eslint (flat config, eslint.config.js)
npm run format:check   # prettier --check (non-blocking)
npm run verify         # typecheck + lint + test in one step

# Start development server (ts-node)
npm start

# Run CLI commands during development
npm start run "natural language instruction"
npm start watch [target]
npm start connect
```

## Architecture

### Core Modules

**CLI Layer (`src/cli.ts`)**
- Entry point with commander.js-based CLI
- Three main commands: `run`, `watch`, `connect`
- Currently scaffolded with placeholder implementations

**Browser Automation (`src/browser.ts`)**
- Playwright wrapper for browser control
- Provides basic functions: `launchBrowser`, `navigate`, `click`, `typeText`, `takeScreenshot`
- Used for UI interaction and visual testing

### Project Structure

```
src/
├── cli.ts                  # CLI interface and command routing
├── browser.ts              # Browser automation wrapper
├── ai-client.ts            # Backward compatibility layer (re-exports)
├── ai-client/              # AI client modules (Phase 2)
│   ├── base.ts            # Abstract base classes for text + vision
│   ├── text.ts            # Text-based AI clients (Phase 1)
│   ├── vision.ts          # Vision AI clients (GPT-4o, Claude Sonnet 5, Ollama)
│   ├── preprocessor.ts    # Image preprocessing pipeline
│   ├── cache.ts           # LRU + SQLite caching system
│   ├── cost-tracker.ts    # Budget management and cost tracking
│   ├── smart-client.ts    # Smart client with fallback logic
│   ├── factory.ts         # Client factory with provider detection
│   ├── models.ts          # Model pins + live provider model-list probe
│   └── index.ts           # Module exports
├── visual/                # Visual testing modules
│   ├── capture.ts         # Screenshot capture with stabilization
│   ├── diff.ts            # SSIM + pixel diff engine
│   └── baseline.ts        # Git-integrated baseline management
├── mcp/                   # MCP stdio server (experimental, spike scope)
│   ├── server.ts          # `iris-mcp` bin — McpServer over StdioServerTransport
│   └── tools.ts           # run_accessibility_test (axe violations only)
├── agent-policy.ts        # What may the agent DO? (allowlist, origin pin, destructive)
├── url-policy.ts          # Is this single URL allowed? (SSRF / scheme gate)
├── hosted.ts              # IRIS_HOSTED switch: read once, fails closed (ADR 0001 §5)
├── url-policy-guard.ts    # Makes that stick per-request (CDP Fetch): redirect hops, sub-resources, popups (#337)
├── egress-proxy.ts        # Hosted: resolve-and-pin HTTP/CONNECT proxy under all Chromium traffic (#336)
├── history.ts             # Records visual/a11y runs to the SQLite history (command layer, not the runners)
└── config.ts              # Configuration types and validation

__tests__/
├── cli.test.ts                    # CLI command testing
├── browser.test.ts                # Browser automation testing
├── ai-client.test.ts              # Text AI client tests
├── ai-client-vision.test.ts       # Vision AI client tests (17 tests)
├── ai-client-preprocessor.test.ts # Preprocessor tests (24 tests)
├── ai-client-batch4.test.ts       # Cache + cost tracker tests (19 tests)
├── ai-client-models.test.ts       # Model pins, provider probe, resolution (26 tests)
├── browser-hardening.test.ts      # One launch factory: spawned argv has no --no-sandbox; context hardening; src/ guard (#331)
├── egress-proxy.test.ts           # Proxy over real sockets: resolved-address refusals, rebinding pin, positive controls (#336)
├── egress-proxy-browser.test.ts   # Hosted Chromium: worker/SharedWorker/WebSocket egress and WebRTC UDP (#336)
├── container-config.test.ts       # Compose hardening, seccomp profile, token file + healthcheck (#332)
├── repo-hygiene.test.ts           # Public repo: no operator IPs/hosts/home paths; no raw tailscale output in workflows (#329)
├── visual/                        # Visual testing tests
│   ├── capture.test.ts
│   ├── diff.test.ts
│   └── baseline.test.ts
└── mcp/
    └── server.test.ts             # Protocol-level: spawns the built server over real stdio

migrations/
├── 001_initial_schema.sql         # Phase 1 database schema
└── 002_ai_cache_cost.sql          # AI cache + cost tracking tables

docs/                               # Detailed project documentation
├── prd.md                         # Product Requirements Document
├── tech_specs.md                  # Technical specifications
├── dev_plan.md                    # Development roadmap
├── user_stories.md                # User stories and acceptance criteria
├── phase2_technical_architecture.md # Phase 2 technical details
├── phase2c_roadmap.md             # Phase 2C roadmap (ROADMAP — not started)
├── integration-surfaces.md        # Which integration surfaces exist and why (decision record)
├── adr/0001-hosted-architecture.md # Hosted SaaS architecture — anchors every Cycle 4 platform issue
└── archive/                       # Superseded planning docs (historical)

plans/
└── README.md                      # Single source of truth: current status / what's next
```

## Development Guidelines

### Current Phase: Phase 2 - Visual Regression & Accessibility (50% Complete)

**Completed: Sub-Phase 2A - AI Vision Foundation (Week 1-4)**
1. ✅ Multimodal AI client architecture (text + vision capabilities)
2. ✅ Vision provider integrations (OpenAI GPT-4o, Anthropic Claude Sonnet 5, Ollama llava)
3. ✅ Image preprocessing pipeline (resize, optimize, hash for caching)
4. ✅ AI vision result caching (LRU memory + SQLite persistence, 30-day TTL)
5. ✅ Cost tracking with budget management (daily/monthly limits, circuit breaker)
6. ✅ Smart client with automatic fallback (Ollama → OpenAI → Anthropic)

**Completed: Sub-Phase 2B - Visual Classification Integration (Week 5-6)**
1. ✅ AIVisualClassifier refactored to use Phase 2A infrastructure
2. ✅ Backward-compatible adapter pattern implementation
3. ✅ Test suite imports the real AIVisualClassifier + provider clients (issue #62; earlier "45 tests" exercised an in-file stub)
4. ✅ Response mapping (AIVisionResponse → AIAnalysisResponse)
5. ✅ Dynamic p-limit import for Jest compatibility

**In Progress: Sub-Phase 2C - Parallel Execution & Performance (Week 8-10)**
- Diff engine integration with AI classifier
- Parallel execution architecture
- Smart caching and incremental testing

### AI Client Architecture (Phase 2A)

**Multimodal Design:**
- `BaseAIClient`: Abstract class for text-based instruction translation
- `BaseAIVisionClient`: Abstract class extending BaseAIClient with vision capabilities
- Provider implementations: OpenAI (text + vision), Anthropic (text + vision), Ollama (text + vision)
- Factory pattern with automatic provider detection and capability checking

**Key Components:**
- **ImagePreprocessor**: Resizes images to API limits (2048x2048), optimizes quality (85% JPEG), calculates SHA-256 hashes
- **AIVisionCache**: Two-tier caching (LRU memory + SQLite), tracks hit rates, automatic TTL expiration. Key identity = provider + model + baseline hash + current hash + optional diff hash + optional context, so a diff-aware verdict is never served for a diff-less request (issue #124)
- **CostTracker**: Real-time cost calculation, budget enforcement with circuit breaker (blocks paid operations only — cache hits and free providers like Ollama always proceed, issue #68), alert thresholds (80%/95%/100%)
- **SmartAIVisionClient**: Intelligent provider selection, cache-first strategy, automatic fallback on failure
- **Diff-aware vision requests**: when the caller supplies a computed pixel diff, it travels as an optional third image (`AIVisionRequest.diff`) to OpenAI, Anthropic, and Ollama alongside a prompt sentence pointing at it. Absent a diff, provider payloads and cache keys are byte-identical to the two-image form. Expect ~30-50% more input tokens per call when it is present (issue #124)
  - The diff mask is preprocessed as **lossless PNG**, not the JPEG used for screenshots: pixelmatch marks unchanged pixels transparent, and JPEG has no alpha channel and blurs the region edges that make the mask worth sending. An empty diff buffer is treated as no diff

**Pricing (default, configurable):**
- Cost is computed from provider-returned token usage when available; the flat per-image rate below is the fallback (cache hits, Ollama, missing usage)
- GPT-4o: $2.50/1M input + $10/1M output tokens (fallback $0.002/image)
- Claude Sonnet 5: $3/1M input + $15/1M output tokens (fallback $0.0015/image) — the vision default
- Claude Haiku 4.5: $1/1M input + $5/1M output tokens (fallback $0.0005/image) — what the `ANTHROPIC_API_KEY` env path selects, so it is the model an out-of-the-box Anthropic user actually requests
- Claude Opus 5: $5/1M input + $25/1M output tokens (fallback $0.004/image)
- Ollama (local): $0.00
- Anthropic rows use the standard rate, not Sonnet 5's introductory $2/$10 (expires 2026-08-31): this table gates a budget circuit breaker, and over-reporting trips it early while under-reporting lets real spend outrun the tracked total
- **Model IDs rot, so they are no longer trusted blind (#184).** The whole `claude-3` family was retired while still pinned in five places, and the vision path was dead until #183. A guard test fails on any re-added quoted `claude-3-*` ID in `src/`. Since #184 every pin lives in `src/ai-client/models.ts` (`DEFAULT_MODELS.text` / `DEFAULT_MODELS.vision`) and is checked against the provider's live model list before use:
  - `listModels(provider, creds)` hits `/v1/models` (OpenAI, Anthropic) or `/api/tags` (Ollama), memoized per provider per process. It returns `null` for "could not check" — never an empty list — so a 401 cannot be mistaken for "no models exist". `IRIS_MODEL_PROBE=0` disables it; `jest.setup.ts` sets that so the suite stays hermetic
  - `resolveModel({provider, kind, model, creds})` returns a listed model as-is, rescues a **retired built-in pin** via longest-prefix match within the same family root, and throws `ModelUnavailableError` for a **user-named** model the provider does not serve. It needs no "was this explicit?" flag: a missing model that equals the pin is our rot, one that differs is the user's typo
  - `SmartAIVisionClient` rethrows `ModelUnavailableError` instead of stepping to the next vendor — that swallow is what made a retired model read as "all providers failed". Text clients resolve via `createResolvedAIClient()`; `loadConfig()` stays synchronous
  - Caveat: `CostTracker` prices by exact model ID, so a rescued successor (`claude-sonnet-5` → `claude-sonnet-5-20260514`) has no pricing row and falls into the #126 "unknown price is billable" path — budget-safe, but unpriced until a row is added

### Container Deployment (issue #192)

`Dockerfile`, `.dockerignore`, `docker-compose.staging.yml` and
`docker/healthcheck.js` ship IRIS as a container. These constraints are easy to
break and expensive to rediscover:

- **Base image is `mcr.microsoft.com/playwright:v<version>-noble`**, tracking the
  `playwright` version in package.json. It carries Chromium *and* its system
  libraries, so no `playwright install --with-deps` at build time. Verified to
  ship Node v24.18.1, satisfying the `engines` floor. Keep the tag in step with
  the library — they are matched pairs.
- **Three stages, deliberately.** `better-sqlite3` has no prebuilt binary here
  and needs node-gyp, which the Playwright image has no `make` for; the compiler
  goes in a `deps` stage and never reaches the shipped image. That stage runs
  `npm ci --omit=dev --ignore-scripts` then `npm rebuild better-sqlite3`, because
  the full lifecycle fails: `"prepare": "npm run build"` needs TypeScript, which
  `--omit=dev` has just removed.
- **The container binds `0.0.0.0`, the host publishes on `127.0.0.1`.** Docker
  forwards a published port to the container's network interface, not its
  loopback, so a loopback bind inside the container refuses every connection
  while looking healthy. The security boundary is the host-side mapping.
- **`shm_size: 1gb`.** Chromium exhausts Docker's 64 MB default and the crash
  reads as an opaque browser disconnect.
- **Sandboxed Chromium needs `docker/seccomp-chromium.json`.** Every launch goes
  through `launchBrowser()` / `newHardenedContext()` in `src/browser.ts` (#331):
  sandbox on, Playwright's signal handlers off, downloads and service workers
  blocked. A guard test fails on any other `chromium.launch` / `browser.newContext`
  in `src/`. Docker's default seccomp allows `unshare`/`setns`/`clone`-with-namespace
  flags and `chroot` only to a container holding `CAP_SYS_ADMIN` / `CAP_SYS_CHROOT`,
  and compose drops every capability (#332). The profile is Docker's default
  (moby/profiles v0.2.3) plus one rule allowing those four. Do not swap in
  Playwright's published profile: it predates `clone3`, which then gets EPERM, and
  glibc falls back to `clone` only on ENOSYS. The deploy probe launches through the
  factory, so it proves the sandbox on the real host.
- **Runtime hardening lives in `docker-compose.staging.yml` (#332)**: `init`,
  `cap_drop: ALL`, `no-new-privileges`, `read_only` with tmpfs for `/tmp` and
  `/home/pwuser`, memory/CPU/pids limits, `stop_grace_period` above the server's
  5s force-exit. `__tests__/container-config.test.ts` pins each one. Measured in
  this image: ~20 pids for the idle server, ~60 more per browser session.
- **The token is a compose secret file**, `IRIS_CONNECT_TOKEN_FILE`, not an env
  var (`docker inspect` shows env). It is a bind mount, so the host file's owner
  and mode apply: readable by uid 1001, inside a 0700 directory.

The healthcheck completes an authenticated JSON-RPC round trip rather than a TCP
open — the socket listens long before the browser layer is usable. It lives in a
file because compose interprets `${...}` in an inline script as its own syntax.

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
- A pinned origin now refuses **every** cross-origin request, images and fonts
  included: an image URL is a write channel for a filled-in secret. The explicit
  allowance is `--allow-cross-origin`.
- `runAgentLoop` with pinning on refuses to start from an opaque origin
  (`about:blank`, `data:`), returning `terminationReason: 'error'`, and
  `checkAction` refuses too. Agent-loop tests therefore serve their fixture from a
  local http origin, not a `data:` URL.

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
- Tests substitute DNS and dialing through `hostedEgressProxy({ lookup, connect })`,
  called before the first launch in the registry. `connect` sends the one "public"
  test address (`8.8.8.8`) to a local server, so every refusal has a positive control
  that goes through the same proxy. A refused target must leave no hit on the server.
- Not covered: a container-level egress firewall, and names Chromium resolves for DNS
  prefetch (a lookup, no connection).

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

### A Red Suite May Be the Machine, Not the Diff (issue #142)

Before treating a local test failure as a regression, check whether the host was
busy. Suites that drive a real Chromium miss their deadlines under CPU load, and
the result reads like a logic bug: a different test each run, usually in code the
change never touched. Re-run the failing suite alone on a quiet machine — passes
alone, fails in the full run means host load.

Measured at `53ba416`: **5/5 clean unloaded, 4/8 clean with half the cores
consumed.** `--coverage` is more prone to it, since instrumentation alone can tip
an operation over its deadline.

Do not "fix" it by raising a timeout or reducing Jest concurrency. Both were
measured and rejected: serialising the browser suites gave an identical failure
rate for +65% wall clock, those suites still failed running one at a time (so
concurrent browser count is not the variable), and the protocol suite's 10s
timeout is 20/20 clean idle against a workflow costing 1.6-3.2s. Raising a limit
deletes the signal rather than the problem.

Separately: a negative elapsed time in output is the WSL2 clock stepping
backward, not contention. It is why no assertion here is written against a
`Date.now()` delta — see #190 for the seven that were replaced.

### Test Hermeticity (issue #185)

`jest.setup.ts` is where the suite is insulated from the developer's machine.
Three guards live there, all for the same reason — a test must not behave
differently because of an untracked file or an exported shell variable:

- `IRIS_DB_PATH` -> a per-worker temp DB, so runs never write to `~/.iris/iris.db`
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

### Configuration Layering (issue #184)

`loadConfig()` merges four layers, most explicit last — it no longer returns
*either* the file config *or* the environment one:

1. built-in defaults (`DEFAULT_MODELS.text[provider]`)
2. environment auto-detection — provider inferred from which `*_API_KEY` / `OLLAMA_ENDPOINT` is exported
3. `~/.iris/config.json`
4. `OPENAI_MODEL` / `ANTHROPIC_MODEL` / `OLLAMA_MODEL`

Consequences worth remembering: a config file no longer disables environment
credentials; an explicit `ai.provider` in the file outranks auto-detection
(presence of a key is a guess, the file is a statement); a `<PROVIDER>_MODEL`
var applies only while that provider is active; and an unparseable config file
degrades to "no file layer" rather than also discarding the environment.

### Phase 1 - Foundations (Complete)
1. ✅ CLI command scaffolding with commander.js
2. ✅ Browser automation with Playwright integration
3. ✅ Natural language translation to browser actions
4. ✅ JSON-RPC/WebSocket protocol layer
5. ✅ Local SQLite persistence for test results

### Testing Strategy
- Jest with ts-jest preset for TypeScript support
- Browser tests use data URLs for isolated testing
- CLI tests mock console output for verification
- Tests are located in `__tests__/` directory

### Build Configuration
- TypeScript compilation from `src/` to `dist/`
- CommonJS modules targeting ES2020
- Strict TypeScript configuration
- Node.js >=20.9.0 required

## Key Dependencies

- **commander**: CLI framework for command parsing
- **playwright**: Browser automation and testing
- **jest + ts-jest**: Testing framework with TypeScript support

## Future Phases

See `docs/dev_plan.md` for complete roadmap:
- Phase 2: Visual regression testing and accessibility validation
- Phase 3: Performance monitoring and AI enhancements

Refer to `AGENT_INSTRUCTIONS.md` for detailed AI agent development guidance.

## Project Assessment Process

You will occasionally be asked to assess the current state of the development project. This involves a comprehensive review to understand where the project stands relative to its specifications and development plan.

### Assessment Steps

1. **Codebase Review**: Thoroughly examine all source code in `src/` and related files to understand current implementation state
2. **Test Analysis**: Run `npm run test` and analyze coverage, pass rates, and test quality
3. **Specification Comparison**: Review documentation in `/docs` directory and compare against actual implementation
4. **Development Plan Review**: Examine `plans/README.md` (the single source-of-truth status tracker) to understand what's marked as complete vs. actual state

### Assessment Output

Create a status report in `plans/status_YYYYMMDDHHMM.md` with the following format:

#### Status
**Red/Yellow/Green assessment** based on:
- Codebase quality and completeness
- Test output and coverage
- Alignment with development plan claims

#### Summary
**Bullet points of positive findings:**
- What has been successfully implemented
- Working functionality confirmed by tests
- Progress that aligns with development plan

#### Feedback
**Bullet points of issues and discrepancies:**
- Functionality claimed as complete but not working
- Test failures or inadequate coverage
- Gaps between development plan claims and actual implementation
- Code quality concerns or architectural issues

This assessment provides an objective view of project status and helps identify where development claims may not match reality.

## Feature Development Quality Standards

**CRITICAL**: All new features MUST meet the following mandatory requirements before being considered complete.

### Testing Requirements

- **Minimum Coverage**: 85% code coverage target for all new code (current repo-wide actual: ~93% statements / ~82% branch — new code should not lower it)
- **Test Pass Rate**: 100% of non-skipped tests must pass (current: 1449/1450 passing, 1 skipped, 0 failing — identical with and without a repo-root `.env`)
- **Test Types Required**:
  - Unit tests for all business logic and core modules
  - Integration tests for browser automation
  - End-to-end tests for CLI commands
- **Coverage Validation**: Run coverage reports before marking features complete:
  ```bash
  # Jest with coverage
  npm run test -- --coverage
  ```
- **Test Quality**: Tests must validate behavior, not just achieve coverage metrics
- **Test Documentation**: Complex test scenarios must include comments explaining the test strategy
- **Browser Testing**: Use data URLs for isolated browser testing

### Git Workflow Requirements

Before moving to the next feature, ALL changes must be:

1. **Committed with Clear Messages**:
   ```bash
   git add .
   git commit -m "feat(module): descriptive message following conventional commits"
   ```
   - Use conventional commit format: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, etc.
   - Include scope when applicable: `feat(cli):`, `fix(browser):`, `test(automation):`
   - Write descriptive messages that explain WHAT changed and WHY

2. **Pushed to Remote Repository**:
   ```bash
   git push origin <branch-name>
   ```
   - Never leave completed features uncommitted
   - Push regularly to maintain backup and enable collaboration
   - Ensure CI/CD pipelines pass before considering feature complete

3. **Branch Hygiene**:
   - Work on feature branches, never directly on `main`
   - Branch naming convention: `feature/<feature-name>`, `fix/<issue-name>`, `docs/<doc-update>`
   - Create pull requests for all significant changes

4. **Phase Alignment**:
   - Ensure features align with current development phase
   - Update development plan when phase goals are completed
   - Reference phase objectives in implementation decisions

### Documentation Requirements

**ALL implementation documentation MUST remain synchronized with the codebase**:

1. **Code Documentation**:
   - TypeScript: JSDoc comments for all public functions, classes, and interfaces
   - Update inline comments when implementation changes
   - Remove outdated comments immediately

2. **Implementation Documentation**:
   - Update relevant sections in this CLAUDE.md file
   - Keep technical specifications current (`docs/tech_specs.md`)
   - Update development roadmap (`docs/dev_plan.md`)
   - Update configuration examples when defaults change
   - Document breaking changes prominently

3. **README Updates**:
   - Keep feature lists current
   - Update setup instructions when dependencies change
   - Maintain accurate command examples
   - Update version compatibility information

4. **Project Status Documentation**:
   - Update status reports in `/plan` directory
   - Keep user stories current (`docs/user_stories.md`)
   - Document new CLI commands and options
   - Update architecture diagrams when structure changes

5. **AGENT_INSTRUCTIONS.md Maintenance**:
   - Keep AI agent guidance current with new patterns
   - Document new testing approaches
   - Update development guidelines

### Feature Completion Checklist

Before marking ANY feature as complete, verify:

- [ ] All tests pass (`npm run test`)
- [ ] Code coverage meets 85% minimum threshold
- [ ] Coverage report reviewed for meaningful test quality
- [ ] TypeScript compilation succeeds (`npm run build`)
- [ ] Code formatted according to project standards
- [ ] All changes committed with conventional commit messages
- [ ] All commits pushed to remote repository
- [ ] Implementation documentation updated
- [ ] Inline code comments updated or added
- [ ] CLAUDE.md updated (if new patterns introduced)
- [ ] Breaking changes documented
- [ ] CLI functionality manually tested
- [ ] Browser automation tested with real scenarios
- [ ] Phase objectives updated (if completed)
- [ ] Status assessment conducted (if major milestone)
- [ ] CI/CD pipeline passes

### Rationale

These standards ensure:
- **Quality**: High test coverage and pass rates prevent regressions in automation tools
- **Traceability**: Git commits provide clear history of changes during development
- **Maintainability**: Current documentation reduces onboarding time and prevents knowledge loss
- **Collaboration**: Pushed changes enable team visibility and code review
- **Reliability**: Consistent quality gates maintain stability of automation framework
- **Alignment**: Features stay aligned with development phases and project goals
- **Assessment**: Regular status checks ensure development claims match reality

**Enforcement**: AI agents should automatically apply these standards to all feature development tasks without requiring explicit instruction for each task.

## Issue Tracking

IRIS tracks active work as **GitHub issues** (via the `gh` CLI). [plans/README.md](plans/README.md) is the canonical "what's next" tracker — if another planning doc disagrees with it, it wins.

### Issue Prioritization Convention (MANDATORY)

**Every new issue MUST be prioritized before it is considered filed.** No issue is left un-triaged.

1. **Title prefix `[PX.Y]`**: every issue title starts with a priority tag, e.g. `[P3.4] Migrate pixelmatch 5.x -> 7.x`.
   - `X` = tier (blast radius / launch impact):
     - **P0** — Launch blocker (`priority-p0`)
     - **P1** — Pre-launch hardening (`priority-p1`)
     - **P2** — Post-launch fast-follow (`priority-p2`)
     - **P3** — Polish / hygiene (`priority-p3`)
   - `Y` = order **within** the tier by importance **and dependency** — lower `Y` = do first / unblocks others. Assign the next free `Y` in the tier, or renumber neighbors if the new issue must come earlier.
2. **Matching label**: add the corresponding `priority-p0..p3` label so tier is filterable (`gh issue list --label priority-p2`).
3. **Placement rule**: slot by both importance and dependency — an issue that blocks others sorts ahead of them within its tier; a working status-quo with no runtime impact sorts to the tail.

To (re)prioritize an existing issue: `gh issue edit <n> --title "[PX.Y] ..." --add-label "priority-pX"`.

### Quick Reference

```bash
# Find work by priority tier
gh issue list --label priority-p1

# Read an issue (context + acceptance criteria) before coding
gh issue view 71

# File discovered work (always with a [PX.Y] prefix + priority label)
gh issue create --title "[P2.9] ..." --label priority-p2 --body "..."
```

### Integration with Development Workflow

1. **Session Start**: Check `plans/README.md` and `gh issue list` for what's next
2. **Before Coding**: Read the issue for context and acceptance criteria
3. **During Implementation**: File discovered issues, prioritized per the convention above
4. **Before Commit**: Verify all acceptance criteria from the issue are met
5. **After Merge**: Issues close via PR closing keywords (`closes #N`); update `plans/README.md` status
