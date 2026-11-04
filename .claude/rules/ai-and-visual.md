---
paths:
  - "src/ai-client/**"
  - "src/ai-client.ts"
  - "src/a11y/**"
  - "src/visual/**"
  - "src/visual-baselines.ts"
  - "src/translator.ts"
  - "src/config.ts"
  - "src/data-dir.ts"
  - "src/db.ts"
  - "src/history.ts"
  - "src/mcp/**"
  - "__tests__/{ai-,vision,config,data-dir,db,a11y,visual}*"
  - "__tests__/{a11y,visual,mcp}/**"
---

### AI Client Architecture (Phase 2A)

**Multimodal Design:**
- `BaseAIClient`: Abstract class for text-based instruction translation
- `BaseAIVisionClient`: Abstract class extending BaseAIClient with vision capabilities
- Provider implementations: OpenAI (text + vision), Anthropic (text + vision), Ollama (text + vision)
- Factory pattern with automatic provider detection and capability checking

**Key Components:**
- **ImagePreprocessor**: Resizes images to API limits (2048x2048), optimizes quality (85% JPEG), calculates SHA-256 hashes
- **AIVisionCache**: Two-tier caching (LRU memory + SQLite), tracks hit rates, automatic TTL expiration (both tiers: the memory tier used to skip the age check, so a long-running server served expired verdicts, #299). Its indexes are `idx_ai_cache_*` and the cost tracker's `idx_cost_*`: SQLite index names are global per file, and a shared `idx_timestamp` left the second table unindexed (#299). Key identity = provider + model + baseline hash + current hash + optional diff hash + optional context, so a diff-aware verdict is never served for a diff-less request (issue #124)
- **CostTracker**: Real-time cost calculation, budget enforcement with circuit breaker (blocks paid operations only — cache hits and free providers like Ollama always proceed, issue #68), alert thresholds (80%/95%/100%)
- **Text and agent turns are metered too (issue #242).** `createResolvedAIClient(config, { operation })` returns a `MeteredTextClient` (src/ai-client/factory.ts), the one place every text call is built (translator → `iris run`/RPC/watcher; agent loop with `agent_turn`). It reserves budget *before* the provider call and settles the reservation with the reply's `usage`, on the same ledger as vision, so one budget covers all AI spend. It opens a tracker per call and closes it afterwards, because the RPC server is long-lived; for that reason the unpriced-model "warn once" set is module-level, not per instance. Text clients return `usage` on every reply the provider sent, including ones IRIS then rejects. A reply with no usage (the request failed before the provider billed) writes no row. The library's other text entry points, `AIClientFactory.create(config, 'text')` and the deprecated `createAIClient()`, return the same metered client without the model check (#386); the raw provider client is module-private
- **Budget is reserved before a call and settled after it (issue #244).** `CostTracker.reserve()` checks the breaker and inserts a `pending = 1` row at the call's worst-case cost (8k in / 1k out tokens at the model's rate; text calls add one token per request character, since the instruction is uncapped short of the RPC payload limit) in one `BEGIN IMMEDIATE` transaction, so calls in flight count against the budget, across connections and processes. `settle(id, usage)` rewrites the row with the real cost; `release(id)` deletes it when no reply came back. Admission is "spend + reservations < limit", so N parallel calls end within the limit plus one call. `trackOperation()` never throws: a call that was answered is paid for, and dropping its row is how spend went missing. A pending row left by a crashed process keeps counting at its estimate (fails safe) until it is an hour old: a tracker opening the ledger then deletes it (#390). `getStats()` reports settled rows only; the budget sums still count reservations. A vision call refused for budget by every vendor rejects with `BudgetExceededError` itself, not "All providers failed", and a paid answer whose settle fails (the client closed mid-call) is returned and the failure logged
  - **Money is summed in integer micro-dollars (#318)**: every row also carries `cost_micros`
    (`toMicros()`: through nano-dollars, then rounded up, so a paid call is never $0 and
    float noise adds nothing), and every sum adds `COALESCE(cost_micros, <cost in micros, rounded up>)`,
    so rows an older release writes (`cost` only) still count; the fallback rounds up the same
    way. The REAL `cost` stays for that release. The upgrade backfills settled rows only, in
    the existing `immediate()` transaction: an older process settles its own pending rows by
    updating `cost`, which a fixed `cost_micros` would ignore (codex review).
  - A reply the provider billed but IRIS rejected (empty, not JSON, outside the schema) throws `AIResponseRejectedError` carrying `usage`, and the smart client settles it before moving on. After a call is settled nothing may send it to the next vendor: a cache-write failure is logged, not treated as a provider failure
- **SmartAIVisionClient**: Cache-first; calls the configured provider only. Other vendors are tried (configured provider still first) only when `enableFallback` is passed or `ai.fallback === true` in the config (#245). The old default walked a fixed `ollama → openai → anthropic` chain, so an OpenAI user with a local Ollama got Ollama's answer and an outage billed a vendor, or a BYOK key, the user never chose. Strict `=== true`, because `config.json` is untyped and `"false"` is truthy
- **A page that grew or shrank is diffed, not refused (#282).** `VisualDiffEngine.compare`
  runs pixelmatch over the overlap and counts every pixel of the larger canvas outside it as
  changed (painted `diffColor` in the diff image). A transparent pad would not do:
  pixelmatch blends alpha against white, so it reads as unchanged beside a white page. Such
  a comparison never passes and carries `layoutChange { baseline, current }` (runner
  result, stored hosted result, every report format). Decoding is bounded:
  `MAX_DECODED_PIXELS` (1920 x 16384) is checked from the header before any pixel is
  allocated, and the padded canvas too; sharp's `limitInputPixels` is the backstop, but it
  also applies to `metadata()`, so the header is read by an unlimited instance
- **pixelmatch options are pixelmatch's (#283).** `DiffOptions.pixelThreshold` is its
  per-pixel `threshold` (default 0.1); `alpha` is only the diff image's opacity (it used to
  feed the threshold too). `includeAA: true` means "count anti-aliased pixels", so the
  runner passes `!antiAliasing`. There is no sampled early exit any more: every comparison
  is the full diff (deterministic, always a diff image), bounded by `MAX_DECODED_PIXELS`
- **Visual reports and the runner (#284).** Image links are relative to the report actually
  written (the default `.iris/reports/…` too, not the cwd). A comparison's `error` is the
  failure reason in every format (HTML line, JUnit `<failure message>`, Markdown `Error:`) and
  in local history (SQLite migration 2: `visual_test_results.error`, bounded and
  userinfo-stripped like hosted). Any `scheme:` page is used as given; only scheme-less
  patterns get the base URL. Local runs may open `file:` and `data:` (like a11y; hosted
  forces both off). Baselines belong to a page URL, so a test that compares two versions of
  a page serves them from one URL (`e2e/visual-diff-e2e.test.ts`), never two `data:` URLs
- **The keyboard tester addresses elements by marker (#285).** Arrow-key and Escape checks
  set a per-run attribute `data-iris-kbd-<nonce>="<kind>-<n>"` on each widget and use that attribute as the selector,
  removed in `finally`; the trap check's marker is per-run too (`data-iris-trap-<nonce>`). Selectors built from id and class were
  invalid for Radix ids (`radix-:r1:`), Tailwind classes and id-less elements, and ambiguous
  between look-alikes. Labels read `getAttribute('class')`: an SVG `<a>`'s `className` is
  an `SVGAnimatedString`, and `.split` on it aborted the whole a11y run
- **Keyboard verdicts come from the keyboard (#286).** Focus order is the real Tab sequence,
  failing only a positive tabindex (manual order) or a stop that is invisible where focus
  lands (ancestors walked: opacity is not inherited); `-1` is the roving-tabindex pattern
  and never fails. No page script can reset the browser's sequential-focus starting point
  (blur keeps it at an autofocused control; focusing `<body>` makes Tab skip positive
  tabindex), so the walk blurs and, when focus wraps to the document part-way, puts the
  stops after the wrap first; it ends on a second wrap, a repeated stop, or 200 stops (an
  informational interaction says so). Stops are the deep active element (shadow roots,
  same-origin iframes); the same stop twice in a row is pressed through (a cross-origin
  frame or closed shadow root). The Escape check focuses inside each dialog before Escape. The Escape check reloads
  the page (`load`, failure tolerated) when the trap check pressed Escape, since that closed
  every Escape-dismissible dialog first. **Escape is judged per dialog (#491)**: each round
  re-finds the first showing (not inert), untested dialog in DOM order, marks and focuses it,
  presses Escape, and asks whether *it* is still open: while its own node is in the document,
  that node's visibility decides; once it is gone, with an
  id, an element with that id showing; else a showing dialog in its place (left, top, width
  within 2 px; height may change), with its name (`aria-label`, `aria-labelledby`, first
  heading) and text containing or contained in its own (a re-render), which is marked tested
  too. No class lists and no page-wide count: a dialog that opened elsewhere, under another
  name, or slid into the gap with other text is a different dialog. At most 50 per page;
  showing dialogs left untested past that are a failed `page` interaction, never a pass
- **The a11y runner isolates pages (#287).** A page that fails (navigation, timeout, a check
  that throws on hostile markup) is that page's result with `error` and an empty axe
  result; the other pages still run. `summary.pagesErrored` counts them, and an errored page
  is never a pass: not in `checkOverallPass`, history (`failed`, the reason kept; SQLite
  migration 3 adds `a11y_test_results.error`), the HTML report ("Could not
  be scanned"), JUnit (`<error>`), the MCP tool (a tool error) or `iris a11y` (lists them,
  exit 3 unless a scanned page has violations: those exit 4, `summary.scannedPassed`).
  The score covers scanned pages only (`null` when none was: an unscanned page has no
  violations and raised it). Errors are userinfo-stripped where they are made
  (`stripUserinfo`, src/report-encoding.ts). The report directory is created before
  writing. The hosted worker sets `failFast` (no browser time on pages whose results
  would be thrown away) and throws the page error itself, keeping fail-the-job semantics
- **A WCAG level is WCAG 2.2 (#290).** `wcagTags(level)` (src/a11y/wcag.ts) is the one
  table: the `iris a11y` `--tags` default, the MCP tool and hosted jobs. AA =
  `wcag2a, wcag21a, wcag2aa, wcag21aa, wcag22aa`; axe tags a rule with the version that
  introduced it, so 2.0 tags alone skipped `autocomplete-valid` and `target-size`. axe's
  `incomplete` is "needs review": MCP `needsReview`, a CLI count, the HTML report and
  JUnit `<system-out>`; never a failure. Hosted runs store it per page (#498:
  `needsReview` count, up to 20 `needsReviewRules`, scanned pages only), shown by the
  Results API and the portal run detail. An explicit `--tags` is checked against the
  installed axe-core (`unknownAxeTags`, #500): a tag that selects no rule is refused with
  exit 2, since an all-typo list scanned nothing and passed
- **One a11y verdict per page (#288).** The runner sets `passed` and `failureReasons` on
  every result (`withVerdict`: axe violations at `--fail-on`, a failed keyboard or
  screen-reader check, or an error), and everything reads it: `summary.passed` (the exit
  code), the HTML page heading (PASSED/FAILED plus reasons), JUnit (per page one testcase
  per check: `axe` fails only at the threshold and lists the rest as `<system-out>`,
  `keyboard`, `screen reader`; root counts are the emitted cases) and history (local and
  hosted `passed`). They used to decide separately, so CI could read `failures="0"` while
  the CLI exited 4
- **axe runs in an isolated world (#350).** `AxeRunner` (src/a11y/axe-integration.ts) runs
  `axe-core` over CDP: `Page.createIsolatedWorld` per frame, `runPartial` per frame,
  `finishRun` in the top frame's isolated world. It shares the DOM, not the page's JS, so a
  pinned `window.axe` or poisoned builtins cannot write the verdict (`@axe-core/playwright`
  ran in the main world: a pinned fake was reported as an axe-core pass). Child frames are
  found in the isolated world (`axe.utils.shadowSelect` -> `DOM.describeNode` -> `frameId`);
  an out-of-process frame needs its own `newCDPSession(frame)` (that call fails for
  in-process frames, which is how they are told apart). Arguments go as CDP values, never
  spliced into source. `toA11yResult` zod-checks the result: malformed is a page error.
  Functions sent to the page are strings, so `--coverage` instrumentation never reaches it
- **A failed analysis is not a verdict (#281).** The classifier answers an outage or a tripped
  breaker with a fallback (`analysisFailed: true`, `severity: 'medium'`). The visual runner
  grades such a comparison by its pixels (`estimateSeverity`), counts it in
  `summary.aiUnavailable`, and `iris visual-diff` prints `AI: unavailable for N comparison(s)`.
  Mapped as `moderate`, a full-page change passed the default `--fail-on breaking`. The
  HTML, JUnit (`iris.aiUnavailable` testsuite property) and Markdown reports carry the same
  run-level note (`aiUnavailableNote()`, src/visual/reporter.ts, #484). A `ModelUnavailableError`
  (a model the provider does not serve) still fails the comparison closed as `breaking`, and now
  counts in `aiUnavailable` with `summary.aiUnavailableReason` naming it
- **Vision capability is a table, Ollama's is its own answer (#298).** `isVisionModel(provider,
  model)` (src/ai-client/models.ts) is the one capability check: id prefixes per family
  (`gpt-4o`, `gpt-4.1`, `gpt-5`, `o1`/`o3`/`o4`; `llava`, `llama3.2-vision`, `gemma3`, `qwen2.5vl`
  …) minus `o1-mini`/`o3-mini` and audio/realtime/tts variants. It replaced name guesses
  (`includes('gpt-4')`, `llava|bakllava`) that skipped every newer vision model and kept the
  text-only `gpt-4`. OpenAI's model list has no capability field, so the table is the source
  there; add a family when OpenAI ships one. Ollama's vision `isAvailable()` asks `/api/show` for
  the **configured** model (it used to accept any pulled llava): `capabilities` decides, the table
  only when an old Ollama reports none, and a 404 (not pulled) is unavailable
- **Ollama probes are bounded and cached (#298).** `probeOllama` (models.ts): 2 s timeout
  (`AbortSignal.timeout`, which also covers the body; `fetchWithTimeout` uses it too since #522, so every Ollama call and the model probe give up on a stalled body), answer
  (promise) cached 60 s per URL and model, `performance.now()` (#190). Text `isAvailable()` is
  `ollamaReachable()` (`/api/tags`, daemon up only: a 503 from the model must still reach the
  caller, `cli-run-exit.test.ts`). `resetModelProbeCache()` clears it too; a test that mocks
  `fetch` for the same endpoint twice must call it between cases
- **OpenAI requests send `max_completion_tokens`**, not the deprecated `max_tokens` (#298);
  Anthropic keeps `max_tokens` (its own API). The o-series refuses any `temperature` but the
  default, so `isReasoningModel()` (`o1`/`o3`/`o4`, `-mini`, snapshots) drops it from both
  OpenAI clients' requests (#520); other models keep 0.1
- **`--ai-model <id>`** on `visual-diff` and `watch` is the vision model (`diff.aiModel`,
  `ai.model` -> `AIVisualClassifier`). `<PROVIDER>_MODEL` stays the text model
- **Vision prompts frame page content (#355).** `visionContextBlock()` (src/ai-client/vision.ts)
  is the one builder of the context all three vision clients send: URL, selector and up to 3
  earlier verdicts inside `--- BEGIN/END UNTRUSTED PAGE DATA ---`, each value through
  `redactFenceMarkers` and capped at 1000 chars (the text prompts' framing). Every vision
  prompt also carries `SCREENSHOT_TEXT_NOTE`: text drawn inside a screenshot is page content,
  never an instruction. Anthropic and Ollama now send earlier verdicts too (only OpenAI did).
  Private backlog item P1.23; criteria derived from the code and listed in the PR
- **Diff-aware vision requests**: when the caller supplies a computed pixel diff, it travels as an optional third image (`AIVisionRequest.diff`) to OpenAI, Anthropic, and Ollama alongside a prompt sentence pointing at it. Absent a diff, provider payloads and cache keys are byte-identical to the two-image form. Expect ~30-50% more input tokens per call when it is present (issue #124)
  - The diff mask is preprocessed as **lossless PNG**, not the JPEG used for screenshots: pixelmatch marks unchanged pixels transparent, and JPEG has no alpha channel and blurs the region edges that make the mask worth sending. An empty diff buffer is treated as no diff

**Pricing (default, configurable):**
- Cost is computed from provider-returned token usage when available; the flat per-image rate below is the fallback (cache hits, Ollama, missing usage)
- GPT-4o: $2.50/1M input + $10/1M output tokens (fallback $0.002/image)
- GPT-4o launch snapshot `gpt-4o-2024-05-13`: $5/1M input + $15/1M output tokens (fallback $0.004/image) — it kept its launch price, so it must not inherit gpt-4o's rate (#243)
- Claude Sonnet 5: $3/1M input + $15/1M output tokens (fallback $0.0015/image) — the vision default
- Claude Haiku 4.5: $1/1M input + $5/1M output tokens (fallback $0.0005/image) — what the `ANTHROPIC_API_KEY` env path selects, so it is the model an out-of-the-box Anthropic user actually requests
- Claude Opus 5: $5/1M input + $25/1M output tokens (fallback $0.004/image)
- Ollama (local): $0.00
- Anthropic rows use the standard rate, not Sonnet 5's introductory $2/$10 (expires 2026-08-31): this table gates a budget circuit breaker, and over-reporting trips it early while under-reporting lets real spend outrun the tracked total
- **Model IDs rot, so they are no longer trusted blind (#184).** The whole `claude-3` family was retired while still pinned in five places, and the vision path was dead until #183. A guard test fails on any re-added quoted `claude-3-*` ID in `src/`. Since #184 every pin lives in `src/ai-client/models.ts` (`DEFAULT_MODELS.text` / `DEFAULT_MODELS.vision`) and is checked against the provider's live model list before use:
  - `listModels(provider, creds)` hits `/v1/models` (OpenAI, Anthropic) or `/api/tags` (Ollama), memoized per provider per process. It returns `null` for "could not check" — never an empty list — so a 401 cannot be mistaken for "no models exist". `IRIS_MODEL_PROBE=0` disables it; `jest.setup.ts` sets that so the suite stays hermetic
  - `resolveModel({provider, kind, model, creds})` returns a listed model as-is, rescues a **retired built-in pin** via longest-prefix match within the same family root, and throws `ModelUnavailableError` for a **user-named** model the provider does not serve. It needs no "was this explicit?" flag: a missing model that equals the pin is our rot, one that differs is the user's typo
  - `SmartAIVisionClient` rethrows `ModelUnavailableError` instead of stepping to the next vendor — that swallow is what made a retired model read as "all providers failed". Text clients resolve via `createResolvedAIClient()`; `loadConfig()` stays synchronous
  - `CostTracker` prices a model with no exact row by its family (#243), but only when the rest of the ID is one snapshot suffix (`-20260514`, `-2024-08-06`, `-latest`): a rescued successor (`claude-sonnet-5` → `claude-sonnet-5-20260514`) or dated snapshot gets its family's rate, while a variant (`gpt-4o-realtime-preview`, `gpt-4oz`) does not, because variants are priced differently. A snapshot that kept a different price needs its own row (`gpt-4o-2024-05-13`). Anything unmatched is charged the dearest registered rate per field (including `setPricing` rows), recorded with `estimated = 1` on its ledger row, and warned about once per pair. It used to record $0, which a budget breaker never trips on. A model dearer than every registered row still under-reports until it gets one. That ceiling stays by decision (#388): a floor above the table (o1-pro class) would make every unpriced model's reservation ~$1.80 and trip a $10 day in a handful of calls; the estimate is flagged and warned, and `setPricing` is the remedy. Every paid default row carries token rates (a test fails on a flat-only one, whose snapshots would ignore usage); `getPricing` resolves a family like the ledger; a token-priced call recorded without usage is charged its flat rate and warns once per pair Free providers (Ollama) stay $0 for every model

### Per-Request AI Credentials (issue #258)

- **`AICredentials { provider, apiKey?, endpoint?, model? }`** (src/ai-client/credentials.ts)
  is one tenant's credential for one request. `configFromCredentials(creds, { kind,
  fallback })` builds the client config from it alone: no env, no `.env`, no
  `~/.iris/config.json`, no other vendor's key, and `fallback` only from the caller (the
  org's opt-in), never the process config's `ai.fallback`.
- **`translate(…, { orgId, credentials })`**: `credentials` is an `AICredentials`, `null`
  (the tenant has no AI: pattern translation only), or a function asked only after
  patterns miss. Omitted is local mode, the process configuration, **except under
  `IRIS_HOSTED`, where omitted means `null`**: a caller that forgets them must not spend
  the operator's keys (ADR 0001 §5).
- **Injected credentials refuse `endpoint` and `ollama`**: AI clients fetch from the
  server process, outside the browser egress controls (#336), so a tenant-chosen URL
  would be an SSRF.
- **The SDK clients pin `authToken: null` (Anthropic) and `organization`/`project: null`
  (OpenAI)**: left undefined, the SDKs read `ANTHROPIC_AUTH_TOKEN` (sent as a second
  credential next to the tenant's key) and `OPENAI_ORG_ID`/`OPENAI_PROJECT_ID` from the
  process. Those variables, and the SDKs' `*_BASE_URL`, are on the `jest.setup.ts`
  scrub list. Base URLs from env are kept: that is the operator's own routing.
- **Vision**: construct `SmartAIVisionClient` / the classifier with
  `configFromCredentials(creds, { kind: 'vision' })`. Its existing vendor scoping
  (`credentialsFor`, #74/#245) then has only the tenant's vendor, so even with the org's
  fallback on, no other vendor is contacted.
- **Hosted RPC**: `startServer({ aiCredentials: (principal) => … })` resolves a tenant's
  credentials per request, lazily; a lookup that throws is logged and becomes no AI, so
  its message never reaches the client. Hosted `iris connect` passes `managedAiResolver` (#344, #479).

### Tenant-Scoped Ledger and Vision Cache (issue #255)

- **`CostTracker(dbPath, budget, { orgId, runId })`**: every row it writes carries the
  org and run (`org_id`, `run_id`, added by idempotent ALTER; `(org_id, timestamp)`
  index), and every budget sum, reservation check and `clear()` reads only its org
  (`org_id IS ?`). So one org's spend, or its calls in flight, never trips another
  org's breaker. No org is local mode: the rows with no org, i.e. everything a ledger
  held before, so local behaviour is unchanged.
- **`getStats()` totals are the tracker's run** when it has a `runId` (daily and monthly
  stay org-wide). `SmartAIVisionClient` opens its tracker with a fresh run id, so a
  visual run's `costSummary` no longer reports every run that ever used the ledger.
- **Cache keys carry `org=<id>` first** when an org is set (`generateKey(..., orgId)`),
  so a verdict one org paid for is never served to another. Local keys keep the old
  format, and existing cache entries survive.
- **The org flows from the request**: `SmartClientConfig.orgId` for vision (the hosted
  visual job API #268 sets it), `createResolvedAIClient(config, { orgId })` for text,
  `translate(instruction, context, { orgId })`, and the RPC server passes the
  session's principal. Every org gets the operator's limits; per-plan limits are
  #260/#346, and Postgres `usage_events` stays the billing record (#263).

### Visual Artifact Layout (issue #343)

- **Names come from `artifactName(page, device)`** (src/visual/artifacts.ts): a slug of
  the page and device plus 10 hex characters of a hash of the exact pair. Only
  `[A-Za-z0-9_-]`, at most 100 characters. The hash is what makes names collision-free;
  the old `page.replace('/', '_')` mapped `/a/b` and `/a_b` to one screenshot and one
  baseline.
- **Each run has its own directory**: `<artifactsDir>/runs/<runId>/{current,diff,baseline}/`
  (`artifactsDir` defaults to `.iris`). Run output no longer sits in `.iris/baselines`,
  where `current`/`diff`/`baseline` took the place of a branch name. `runId` (config, or
  `newRunId()`: UTC time plus 8 random hex characters) is returned on the result;
  `runArtifactPath()` refuses a run id or name outside `[A-Za-z0-9_-]`.
- **Baselines use the new name**, but `loadBaseline([newName, legacyName], ref)` still
  finds one saved under `legacyArtifactName()`, so an upgrade does not orphan existing
  baselines. Both names are tried on the branch before main's, so a feature branch's own
  old-name baseline wins over main's new one. The next `--update-baseline` writes the
  new name. Pages that used to collide (`/a/b`, `/a_b`) share the legacy file until
  then: update their baselines after upgrading.
- **Old runs are pruned at the end of a run (#425)**: `pruneRuns()` keeps the newest
  `keepRuns` run directories (default `DEFAULT_KEEP_RUNS` = 20, `--keep-runs`, 0 keeps all),
  this run counted and never removed; newest by mtime (a caller's run id need not sort).
  Only directories named like a run id go. A prune failure is logged, never fails the run.
- **The run id is on every surface**: the result, the JSON report (`runId`) and the
  `iris visual` summary line. A caller-supplied `runId` is trusted to be unique; reuse
  writes into the same run directory.
- Runner tests set `artifactsDir` to a temp directory: the runner really creates the
  run directories (only `writeFileSync` is mocked there).

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


### Data Directory and Budgets (issue #241)

- `resolveDataDir()` (src/data-dir.ts): `IRIS_DATA_DIR` > `dirname(IRIS_DB_PATH)` >
  `~/.iris`, always absolute. History (`resolveDbPath()`), the cost ledger and the
  vision cache (`<data dir>/cache/`) all use it. The ledger used to be cwd-relative,
  so every directory had its own fresh daily budget.
- The smart client resolves paths and limits **when constructed**, not at import,
  so tests and long-lived processes follow the environment of the moment.
- `resolveBudget()` (src/config.ts): `IRIS_DAILY_BUDGET_USD` / `IRIS_MONTHLY_BUDGET_USD`
  > `budget` in `~/.iris/config.json` > `DEFAULT_BUDGET_LIMITS` ($10 / $200), per field.
  Malformed values throw `ConfigError` (#603), which `translate()` and the agent loop treat like
  the budget breaker: a plain failure (`iris run` exit 1), never a provider outage (3). An
  explicit `costConfig` passed to the client still wins.
  `createCostTracker(dbPath, budget?)` fills omitted limits the same way (#365); with both
  limits given it never reads `resolveBudget()`, so a malformed variable cannot throw there.
- Container: compose sets `IRIS_DATA_DIR: /data`, the only durable writable path
  under the read-only root filesystem.
- Under Jest, `process.env.HOME` does not move `os.homedir()` (the env is a copy);
  spy on `os.homedir` instead.

### Local SQLite Schema (issue #321)

The local stores define their schema in code only (the dead `migrations/*.sql` were
removed): the history store (`src/db.ts`) runs ordered versions from `schema_version`
(`applyMigrationV1..V3`, in one `immediate()` transaction); the cost ledger creates its
table and adds missing columns idempotently on open (`PRAGMA table_info`); the vision cache
creates its table and indexes (`IF NOT EXISTS`) and has no upgrade path yet.
A schema change is a new `applyMigrationVn` (history) or a guarded `ALTER` (the ledger's
upgrade transaction; the cache would need one added).
