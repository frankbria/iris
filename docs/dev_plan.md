# Development Plan

**Version:** 1.0

**Project:** AI-Driven UI Development Orchestrator

**Date:** 2025-09-18

---

## 1. Development Philosophy

- **Incremental Value:** Every phase delivers something that can be demoed and used.
- **Pragmatism First:** Start with Playwright + CLI foundations, layering in AI gradually.
- **AI as an Assistant, not Replacement:** Leverage AI for translation, pattern recognition, and suggestions — always with human-verifiable outputs.
- **Stable Core, Flexible Edges:** Orchestrator core remains simple and tested; integrations (AI models, coding tools) can evolve rapidly.

---

## 2. Development Phases & Deliverables

### **Phase 1 – Foundations (Core CLI & Browser Automation)**

**Objective:** Build the bedrock of the orchestrator: CLI, Playwright integration, watch mode.

- Deliverables:
    - CLI with basic commands (`run`, `watch`, `connect`)
    - Playwright browser automation module
    - Natural language → Playwright translation (via AI API + fallback rules)
    - JSON-RPC & WebSocket protocol for integrations
    - SQLite storage of test runs

**Rationale:** Without this, nothing else matters — it’s the skeleton that all testing layers hang on.

---

### **Phase 2 – Enhanced Testing (Visual Regression & Accessibility)**

**Objective:** Add value beyond standard Playwright — what makes this “AI-driven” and useful out of the box.

- Deliverables:
    - Screenshot capture and baseline comparison
    - Visual diff engine (pixel comparison + AI anomaly classification)
    - axe-core integration for WCAG compliance
    - Keyboard navigation + screen reader simulation tests

**Rationale:** Visual + accessibility are high-value, hard-to-do manually, and instantly demonstrable.

---

### **Phase 3 – Performance Intelligence**

**Objective:** Integrate page performance monitoring and optimization suggestions.

- Deliverables:
    - Lighthouse audit automation
    - Core Web Vitals (LCP, CLS, FID) collection
    - AI-generated optimization suggestions (e.g., “lazy load these images”)
    - SQLite storage + trend reporting

**Rationale:** Performance is measurable, impactful, and enhances adoption among dev/QA stakeholders.

---

### **Phase 4 – Multi-Tool Integration**

**Objective:** Connect orchestrator with AI coding environments (Claude, Codex, Warp).

- Deliverables:
    - Adapters for 2–3 AI tools
    - Shared context protocol (test results passed back into coding tool)
    - Synchronized dev workflow (AI can “see” UI test feedback in real time)

**Rationale:** This is the differentiator — making the orchestrator indispensable in AI-assisted coding pipelines.

---

### **Phase 5 – Autonomy & Learning (Advanced AI-Driven Testing)**

**Objective:** Move toward autonomous, self-learning test generation.

- Deliverables:
    - AI-driven test generation from observed flows
    - Vector DB for storing UI patterns + reusable test suites
    - Continuous learning from historical test results

**Rationale:** This is the moonshot feature — positions the orchestrator as not just a runner of tests, but a *creator* of them.

---

## 3. Development Timeline (Indicative)

Assuming **2-week sprints**, small team (2–3 engineers):

- **Q4 2025:** Phase 1 completed (CLI, Playwright, watch mode).
- **Q1 2026:** Phase 2 visual regression + accessibility.
- **Q2 2026:** Phase 3 performance monitoring.
- **Q3 2026:** Phase 4 multi-tool integration.
- **Q4 2026:** Phase 5 AI-driven test generation + learning.

---

## 4. Team Roles & Responsibilities

- **Tech Lead / Orchestrator Architect**: Core CLI + API contracts.
- **Frontend/Automation Engineer**: Playwright integration, visual regression.
- **AI Engineer**: Natural language translation, AI-driven anomaly detection.
- **QA Engineer**: Accessibility & performance testing implementation.
- **DevOps Engineer (part-time)**: CI/CD pipelines, release automation, packaging.

---

## 5. Tooling & Infrastructure

- **Repo Setup:** Monorepo (CLI + orchestrator core + adapters).
- **CI/CD:** GitHub Actions → automated tests on PRs, packaged binaries on release.
- **Testing:** Vitest/Jest for unit tests, Playwright for E2E tests of the orchestrator itself.
- **Deployment:** Node.js CLI published to npm; optional Docker container distribution.
- **Storage:** SQLite local DB for results; Vector DB for AI pattern recall.

---

## 6. Risk Management

- **Flaky Tests:** Use AI-driven waits and retries, fallback to selector-based control.
- **False Positives in Visual Diffs:** Combine pixel-based + AI semantic classification.
- **AI API Latency/Cost:** Prioritize local models for frequent tasks; cloud APIs for complex parsing.
- **Integration Fragility:** Use adapters with versioned contracts to avoid breaking changes in external AI tools.

---

## 7. Success Criteria

- Working MVP (Phase 1) within **3 months**.
- Visual regression + accessibility features reduce manual QA time by **50%**.
- Performance monitoring catches **80% of regressions** before production.
- Multi-tool integration adopted by **2 AI coding tools** in first year.
- Autonomous test generation covers **70% of standard UI flows** by end of year 2.

# Technical Specifications

**Version:** 1.0

**Date:** 2025-09-18

**Owners:** Tech Lead (Orchestrator), Automation Eng (Playwright), AI Eng (NL → Actions), QA Eng (a11y/perf)

**Target Runtime:** Node.js 20+ (TypeScript), optional Rust via NAPI for hot paths

---

## 0) Definitions & Abbreviations

- **NL Command**: Natural-language command (e.g., “Ensure the modal closes when clicking outside”).
- **AIA**: AI Interpreter & Action planner that turns NL commands into executable plans.
- **Exec Plan**: Structured, deterministic plan: ordered steps (selectors, actions, assertions).
- **O11y**: Observability (logs, metrics, traces).
- **MCP**: Model Context Protocol (Claude ecosystem).
- **CDP**: Chrome DevTools Protocol.

---

## 1) Repository & Project Layout

```
/orchestrator
  /packages
    /cli                # TS CLI, Commander/Yargs
    /core               # Orchestrator engine, plan runner, adapters
    /playwright-driver  # Thin wrapper around PW (browser mgmt, fixtures)
    /ai-interpreter     # Prompting, parsing, tool schemas, planning
    /visual             # Screenshot capture, diff (pixel + semantic)
    /a11y               # axe-core harness, keyboard nav, SR heuristics
    /perf               # Lighthouse runner, CWV collector
    /integrations
      /mcp              # MCP server and tools
      /jsonrpc          # JSON-RPC 2.0 bridge
      /adapters         # claude-code, warp, codex
    /persistence        # SQLite, migrations, file storage
    /vector             # Chroma/Weaviate client + embedding
    /schema             # Zod/JSON Schemas shared across packages
    /utils              # Logger, config, retries, time, env
  /examples             # Minimal demo apps + golden flows
  /docs                 # Tech docs, ADRs, HOWTOs
  /scripts              # Dev scripts, release pipeline helpers

```

- **Build system:** pnpm workspaces + turbo for caching
- **Type checking:** `tsc -p tsconfig.build.json`
- **Lint/format:** ESLint + Prettier (monorepo root config)

---

## 2) Configuration & Environment

**Config precedence:** CLI flags > ENV > `orchestrator.config.{json,yml,ts}`

**Core keys:**

```tsx
type OrchestratorConfig = {
  app: {
    url?: string;                // e.g., http://localhost:3000
    launch: { headless: boolean; browser: 'chromium'|'firefox'|'webkit'; timeoutMs: number };
    auth?: { username?: string; password?: string; token?: string };
  };
  ai: {
    provider: 'openai' | 'anthropic' | 'ollama';
    model: string;               // e.g., 'gpt-4.1-mini' or local name
    maxTokens: number;           // default 2k
    temperature: number;         // default 0.1
    useVision: boolean;          // enable screenshot-grounded prompting
  };
  storage: {
    sqlitePath: string;          // default ./.orchestrator/state.sqlite
    artifactsDir: string;        // default ./.orchestrator/artifacts
    vectorDb: { provider: 'chroma'|'weaviate'; url: string; index: string };
  };
  visual: {
    baselineBranch?: string;     // default 'main'
    diffThreshold: number;       // 0..1; default 0.12
    semanticEnabled: boolean;    // toggles Resemblyzer/CLIP-style pass
  };
  a11y: {
    axeConfigPath?: string;      // custom rules
    failOn: ('critical'|'serious'|'moderate'|'minor')[];
  };
  perf: {
    lighthouseFlags: string[];   // e.g., ['--throttling-method=provided']
    budgetsPath?: string;        // Lighthouse budgets.json
  };
  watch: {
    include: string[];           // glob paths
    debounceMs: number;          // default 250
  };
  logging: {
    level: 'error'|'warn'|'info'|'debug'|'trace';
    json: boolean;
  };
};

```

**Secrets:** loaded from `.env` via dotenv (API keys, tokens). Never persisted to SQLite.

---

## 3) CLI Specification

### Commands

1. `orc run "<nl command>" [--url /path] [--trace] [--report=json]`
    - Runs a single NL Command against current app.
    - Returns pass/fail with assertions and file/line hints (if available).
2. `orc watch [--patterns "src/**/*.ts,app/**/*.tsx"] [--plan-cache]`
    - Re-runs plans on file change; incremental planning if `-plan-cache` on.
3. `orc visual-diff [--pages "/, /login"] [--baseline main] [--semantic]`
    - Captures screenshots, compares with baseline, outputs diff report.
4. `orc a11y [--pages "/, /checkout"] [--fail-on serious,critical]`
    - Runs axe-core + keyboard traversal; writes findings.
5. `orc perf [--pages "/dashboard"] [--budgets ./budgets.json]`
    - Lighthouse audits + CWV capture; budgets enforced if provided.
6. `orc connect <tool> [--port 8765]`
    - Starts MCP/JSON-RPC bridge for AI coding tools.
7. `orc init`
    - Scaffolds config, recommended gitignore, example plans, budgets.json.

**Global flags:** `--config`, `--log-level`, `--json`, `--no-color`, `--headful`

**Exit codes:**

- `0` success, no policy violations
- `1` failed assertions/tests
- `2` configuration error
- `3` environment/runtime (e.g., browser launch failure)
- `4` budget/a11y threshold violation
- `5` visual diffs exceed threshold

---

## 4) AI Interpreter & Plan Format

### 4.1 Tools (function-calling style)

The AI is confined to tool schemas; all side effects happen through orchestrator tools.

- `queryDom(selector | semanticQuery): DomNode[]`
- `click(selector, opts)`
- `type(selector, text, opts)`
- `press(keyCombo)`
- `waitFor(selector|state, timeoutMs)`
- `assertVisible(selector)`
- `assertText(selector, expectation)` // equals, contains, regex
- `assertVisual(selector|viewport, expectation)` // see §7
- `navigate(urlOrPath)`
- `collectPerfMarks()`
- `runAxe(config)`
- `keyboardTraverse(strategy)` // tab/shift+tab path exploration

### 4.2 Prompt Skeleton (system → developer → user)

- **System:** constraints (never exec external code; produce deterministic plan; prefer robust selectors).
- **Developer:** available tools, app context (routes, known components), guardrails (time budget, retry policy).
- **User:** the NL Command itself + optional context (recent failures, code diffs summary).

### 4.3 Exec Plan Schema (Zod)

```tsx
const Step = z.object({
  id: z.string(),
  action: z.enum([
    'navigate','click','type','press','waitFor','assertVisible','assertText','assertVisual'
  ]),
  args: z.record(z.unknown()),
  retry: z.object({ attempts: z.number().min(1).max(3), backoffMs: z.number() }).optional(),
  timeoutMs: z.number().default(10000),
  screenshot: z.boolean().default(false)
});

const ExecPlan = z.object({
  version: z.literal('1'),
  description: z.string(),
  preconditions: z.array(z.string()),     // e.g. "server running", "user logged out"
  steps: z.array(Step).min(1),
  postconditions: z.array(z.string()),    // e.g. "form shows error for bad email"
  assertions: z.array(z.object({
    type: z.enum(['visible','text','visual']),
    target: z.string(),
    expectation: z.string()
  })),
});

```

**Behavior:**

- Plan is validated before execution.
- Each step’s side effects are wrapped in Playwright operations with standardized wait conditions.
- Retries only on recognized transient errors (navigation timeout, detached element).

---

## 5) Playwright Driver

### 5.1 Browser Lifecycle

- One **BrowserContext** per plan; reuse allowed in `watch` mode with cleanup per test.
- Default **tracing** off; enable via `-trace` to record HAR + video.

### 5.2 Selector Strategy (in order):

1. **Data-testid**/role attributes (`[data-testid="submit"]`, ARIA roles).
2. **Accessible name** via `getByRole('button', { name: 'Submit' })`.
3. **Semantic mapping** (AI proposes, driver resolves to deterministic locator).
4. **DOM path** fallback is **disallowed** unless whitelisted (flaky).

### 5.3 Wait Strategy

- Implicit `waitForLoadState('domcontentloaded')` after navigation.
- For actions: `locator.waitFor({ state: 'visible' })` + `actionability` checks.
- For AJAX: `page.waitForResponse` with heuristic timebox 1.5× recent median.

---

## 6) Persistence Layer (SQLite)

### 6.1 Tables

```sql
CREATE TABLE test_runs (
  id TEXT PRIMARY KEY, started_at INTEGER, finished_at INTEGER,
  command TEXT, status TEXT, url TEXT, trace_path TEXT, plan_json TEXT
);

CREATE TABLE assertions (
  id TEXT PRIMARY KEY, run_id TEXT, type TEXT, target TEXT,
  expectation TEXT, status TEXT, message TEXT, FOREIGN KEY(run_id) REFERENCES test_runs(id)
);

CREATE TABLE visual_diffs (
  id TEXT PRIMARY KEY, run_id TEXT, target TEXT,
  base_path TEXT, new_path TEXT, diff_path TEXT,
  diff_score REAL, semantic_score REAL, severity TEXT
);

CREATE TABLE a11y_issues (
  id TEXT PRIMARY KEY, run_id TEXT, page TEXT,
  rule TEXT, impact TEXT, node_selector TEXT, help_url TEXT
);

CREATE TABLE perf_metrics (
  id TEXT PRIMARY KEY, run_id TEXT, url TEXT, metric TEXT, value REAL, details_json TEXT
);

CREATE TABLE ui_patterns (
  pattern_id TEXT PRIMARY KEY, embedding BLOB, description TEXT, usage_count INTEGER
);

```

### 6.2 Migrations

- Use `drizzle-kit` or `knex` migrations in `/persistence/migrations`.
- Migration policy: backward compatible schema changes within minor versions.

---

## 7) Visual Regression Engine

### 7.1 Capture

- `page.screenshot({ fullPage: true, animations: 'disabled' })`
- Per-selector screenshot with `locator.screenshot()` when target given.

### 7.2 Diff Stages

1. **Pixel Diff**: SSIM/PSNR or pixel-wise with anti-aliasing tolerance; produces heatmap.
2. **Semantic Pass (optional)**:
    - Resize to model input; compute embedding (Resemblyzer/CLIP-like).
    - Cosine distance vs baseline; threshold configurable (`semanticThreshold`, default 0.08).
3. **Classification**:
    - Heuristics: text reflow small change → acceptable; color/spacing over threshold on critical region → breaking.
    - Region weights: headers/nav/CTA higher weight.

### 7.3 Output

- Artifacts: `baseline.png`, `candidate.png`, `diff.png`, `report.json`
- Severity: `none | minor | moderate | breaking`
- Exit code `5` if any `breaking` diffs unless `-allow-breaking`.

---

## 8) Accessibility Module (axe-core)

### 8.1 Rules

- Default rule set = axe recommended + WCAG 2.1 AA.
- Config override via `axeConfigPath`.

### 8.2 Keyboard Navigation

- Strategy: simulate `Tab`/`Shift+Tab` traversal; collect focus order, trap detection, outline visibility.
- Fail when:
    - Focus trap without escape.
    - Interactive element unreachable by keyboard.
    - Focus ring absent for keyboard users (CSS outline none without replacement).

### 8.3 Screen Reader Heuristics

- Verify ARIA roles present and consistent with semantics.
- Ensure name/role/value are exposed; image alt coverage > 98% on page.

### 8.4 Reporting

- CSV + JSON outputs with `impact` buckets.
- Exit code `4` if any issue with impact ∈ configured `failOn`.

---

## 9) Performance Module

### 9.1 Lighthouse Runner

- Headless Chrome with configurable flags.
- Categories collected: Performance, Accessibility (for cross-check), Best Practices, SEO, PWA (optional).
- Budget enforcement if `budgets.json` provided:

```json
[{ "path": "/*", "resourceSizes": [{ "resourceType": "script", "budget": 170 }], "timings": [{ "metric": "interactive", "budget": 5000 }] }]

```

### 9.2 Core Web Vitals

- `LCP`, `CLS`, `INP` via `web-vitals` injected script on monitored pages.
- Aggregation across runs; trend line stored to `perf_metrics`.

### 9.3 Suggestions

- AI post-processor reads Lighthouse JSON and code diffs summary (optional) to produce prioritized recommendations (action, file hints, estimated impact).

---

## 10) Integration Layer

### 10.1 JSON-RPC 2.0

- Methods: `orchestrator.execute`, `orchestrator.results`, `orchestrator.subscribe`, `orchestrator.cancel`
- Notifications: `orchestrator.event` (runStarted, stepCompleted, runFinished)

### 10.2 MCP Server

- Tools exposed: `run_nl_command`, `visual_diff`, `a11y_check`, `perf_audit`, `get_last_results`
- **Contract:** All requests idempotent; streaming tokens for live progress.

### 10.3 Tool Adapters

- **claude-code**: converts editor selection + test intent → `run_nl_command`.
- **warp**: shell integration for one-shot runs with rich TUI blocks.
- **codex**: thin JSON-RPC transport; same method surface.

---

## 11) Security & Privacy

- **No app code exfiltration:** Only summarized context (file paths, small diffs) sent to cloud models; configurable redaction rules.
- **Local-first AI option:** Ollama model map for `tiny`/`base` planners.
- **Secrets handling:** Keys only in memory; redact in logs; never stored.
- **Sandboxing:** Browser contexts isolated; file artifacts scoped per run directory.

---

## 12) Observability

### 12.1 Logging

- Pino logger with `level` from config; JSON optional.
- Correlation ID per run; step-level timings.

### 12.2 Metrics

- Prometheus endpoint (opt-in):
    - `orc_runs_total{status}`, `orc_step_duration_ms{action}`, `orc_visual_breaking_total`, `orc_a11y_violations{impact}`

### 12.3 Tracing

- OpenTelemetry SDK (http/jsonrpc spans, PW action spans).
- Exporters: console, OTLP.

---

## 13) Error Handling & Retry Policy

- **Categories:** ConfigError (2), EnvironmentError (3), AssertionFailure (1/4/5), TransientError (auto-retry).
- **Retries:** Up to 2 for TransientError with exp backoff (250ms, 750ms).
- **Plan-level circuit break:** if >30% steps fail transiently twice, abort early.

---

## 14) Testing Strategy

### 14.1 Levels

- **Unit:** utils, schema validation, diff math, prompt slicers.
- **Contract:** JSON-RPC, MCP tool contracts (positive & negative).
- **Integration:** PW driver against demo app (login, modal, nav).
- **System:** end-to-end orchestrator run using `examples/demo-store`.
- **Non-regression:** Golden screenshots, plan snapshots.

### 14.2 Coverage Targets

- Unit 90% lines; Integration 80% critical paths; System happy-path daily.

### 14.3 CI Matrix (GitHub Actions)

- Node 20, 22; OS: ubuntu-latest (required), windows-latest (smoke), macos-latest (smoke).
- Lint → Typecheck → Unit → Integration (headless) → Package → Publish canary.

---

## 15) Packaging & Distribution

- **CLI name:** `orc` (fallback `orchestrator`)
- **Publish:** npm (scoped, e.g., `@orchestrator/cli`), GitHub Releases (attached binaries via `pkg` optional).
- **Artifacts:** store under `.orchestrator/artifacts/<runId>/...`

---

## 16) Backward Compatibility & Versioning

- **SemVer** across packages; cross-package ranges pinned via workspace protocol.
- **Config migrations:** minor versions must auto-upgrade known keys; warn on deprecations.

---

## 17) Acceptance Criteria by Capability

### 17.1 NL Command Execution

- Given an app with a login form, command:
    
    `"Type 'user@example.com' into the email field, type 'bad' into the password field, click Sign in, and verify an error is shown."`
    
- **Pass** when:
    - Email and password fields located with stable selectors (data-testid/role/name).
    - Button clicked; app produces error visible within 2s.
    - CLI outputs: step log, assertion result, DOM snippet of error element, and a screenshot artifact.

### 17.2 Visual Diff

- With baseline on branch `main`, running `orc visual-diff --pages "/, /products"` on `feature/card-tweak`:
    - **Fail** when any page has `severity=breaking` determined by diff + semantic pass.
    - Report includes clickable paths to `diff.png`.

### 17.3 Accessibility

- Running `orc a11y --pages "/checkout" --fail-on serious,critical`:
    - **Fail** if any axe violation of those impacts; report lists rule IDs, nodes, help URLs.

### 17.4 Performance

- Running `orc perf --pages "/dashboard" --budgets ./budgets.json`:
    - **Fail** if interactive > 5s or script budget exceeded.
    - Suggestions include bundle split candidates with file hints (when detectable).

### 17.5 Watch Mode

- On file change to `src/components/Login.tsx`, affected plans re-run within 2s debounce.
- CLI updates in-place with last run status; retains last 20 runs in SQLite.

---

## 18) Detailed Algorithms & Heuristics

### 18.1 Selector Robustness Score (SRS)

- Score 0-1 combining:
    - Attribute stability (data-testid > role > text > nth-child)
    - DOM depth penalty
    - Sibling volatility (frequent layout changes)
- Reject any action with SRS < 0.55 unless user opts `-unsafe-selectors`.

### 18.2 Visual Severity Heuristic

```
severity =
  if diffAreaPct < 0.8% and semanticScore < 0.05 -> 'none'
  else if criticalRegion && (diffAreaPct > 1% || semanticScore >= 0.08) -> 'breaking'
  else if diffAreaPct between 0.8%..2% -> 'moderate'
  else -> 'minor'

```

### 18.3 Keyboard Traversal Graph

- Build graph of tabbable elements in DOM order; detect cycles (traps).
- Ensure accessible name presence on each interactive node.

---

## 19) Developer UX Details

- **JSON output mode** for all commands (`-json`) returns:

```json
{
  "runId": "2025-09-18T20-15-02.123Z",
  "status": "passed",
  "assertions": [{ "type":"text","target":"#error","status":"passed" }],
  "artifacts": { "screenshots":["./.orchestrator/artifacts/.../00.png"] }
}

```

- **Rich TTY**: step spinners, timing badges, diff thumbnails (ASCII block maps if no images).

---

## 20) ADRs (initial decisions)

1. **Playwright over Puppeteer** for multi-browser parity & fixtures.
2. **SQLite** local store over cloud DB for zero-setup developer ergonomics.
3. **Function-calling AI pattern** for safety and determinism; no free-text “run JS”.
4. **Zod schemas** as single source of truth across packages and API boundaries.

---

## 21) Milestone-Level DoD (Definition of Done)

- Code + unit tests merged to `main` with green CI.
- CLI help updated; docs page under `/docs/capability/<feature>.md`.
- Example in `/examples` demonstrating feature.
- Metrics counters added or updated.
- Changelog entry with migration notes (if any).

---

## 22) Sample End-to-End Flow (Login Validation)

1. `orc run "Open /login, type an invalid email, submit, ensure email format error appears." --url http://localhost:3000`
2. AIA creates Exec Plan (navigate → type → click → assertText on error).
3. Core validates plan via Zod; rejects unsafe selectors.
4. PW Driver executes with auto-wait; screenshots after each step (debug mode).
5. Assertions written to SQLite; artifacts saved; CLI prints summary; exit code reflects status.

---

## 23) Future-Facing Hooks (Phase 5)

- **Plan Cache**: Store successful plans keyed by NL hash + app commit; re-use without round-tripping to AI.
- **Pattern Mining**: Cluster embeddings of successful flows → propose missing coverage.
- **Self-Healing Selectors**: When a selector breaks, AIA proposes next-best with SRS delta and asks for opt-in replacement (`-auto-heal`).
