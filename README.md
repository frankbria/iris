# IRIS - Interface Recognition & Interaction Suite

[![Follow on X](https://img.shields.io/twitter/follow/FrankBria18044?style=social)](https://x.com/FrankBria18044)

> 👁️ AI-powered UI understanding and testing toolkit

**Phase 1: ✅ Complete** | **Phase 2: 🟡 75% Complete (CLI, Accessibility, AI Vision Foundation)**

IRIS gives AI coding assistants "eyes and hands" to see and interact with user interfaces through natural language commands, visual regression testing, and accessibility validation.

---

## Current Status

### ✅ Phase 1 - Complete (Production-Ready)

**Core Features Available:**
- ✅ Natural language UI commands with AI translation
- ✅ Browser automation via Playwright
- ✅ File watching with automatic re-execution
- ✅ JSON-RPC protocol for AI coding assistant integration
- ✅ SQLite persistence for test runs and results
- ✅ Multi-provider AI support (OpenAI/Anthropic/Ollama)

### Phase 2 - Visual Regression & Accessibility (In Progress)

**Status:** Visual regression complete; accessibility runner functional (axe-core, keyboard, ARIA) with some `src/a11y/index.ts` convenience wrappers still stubbed. 575/576 tests passing, integration ongoing.

**Visual Testing Core:**
- ✅ Visual capture engine with page stabilization and masking
- ✅ SSIM and pixel-based diff engine with region analysis
- ✅ Git-integrated baseline management (branch/commit/timestamp strategies)
- ✅ Multi-device testing (desktop, tablet, mobile)
- ✅ Complete TypeScript/Zod type system

**AI Vision Integration:**
- ✅ AI-powered semantic analysis (OpenAI GPT-4o, Claude 3.5 Sonnet, Ollama)
- ✅ Multimodal AI client architecture (src/ai-client/ - reusable for future AI vision tasks)
- ✅ Image preprocessing pipeline (resize, optimize, base64 encoding)
- ✅ AI vision result caching (LRU memory + SQLite persistence)
- ✅ Cost tracking with budget management and circuit breaker
- ✅ Smart client with automatic fallback and cost optimization

**CLI & Reporting:**
- ✅ CLI commands: `iris visual-diff` and `iris a11y`
- ✅ Multi-format reporting (HTML, JSON, JUnit, Markdown)
- ✅ Visual reporter with diff viewer and interactive HTML reports

**Accessibility Testing:**
- ✅ WCAG 2.1 Level AA/AAA compliance validation with axe-core
- ✅ Keyboard navigation testing (Tab order, focus traps, arrow keys)
- ✅ Screen reader simulation (ARIA labels, landmarks, headings)

**Examples & Documentation:**
- ✅ 4 example projects (basic visual, multi-device, accessibility, CI/CD)
- ✅ Comprehensive API documentation and user guides
- ✅ CI/CD integration examples

**Test Results:** 575/576 tests passing (99.8% pass rate), 1 skipped, 0 failing

**Coverage:** 75.7% statements overall (below the 85% target)
- Branch coverage: 57.34% (primary improvement area)

_Metrics last verified: 2026-06-26_

**Status:** Usable for visual regression today; accessibility integration and the `src/a11y/index.ts` wrappers are still in progress (see open issues).

---

## Quick Start

### Installation

```bash
git clone https://github.com/frankbria/iris.git
cd iris
npm install
npm run build
npm link
```

### Verify Installation

```bash
iris --version
```

### Verify Your Setup

Run the project's quality gates (typecheck, lint, and tests) in one step:

```bash
npm run verify
```

IRIS reads its credentials from environment variables (see `.env.example` for the
full list). Copy the example to `.env` and fill in what you need — the CLI
auto-loads `.env` from the working directory at startup:

```bash
cp .env.example .env
# edit .env with your keys
```

Shell-exported variables take precedence over `.env`, so `export OPENAI_API_KEY=…`
always overrides a file value.

### Try the Demo (Fastest Way)

```bash
bash <(curl -s https://raw.githubusercontent.com/frankbria/iris/main/scripts/demo-setup.sh)
```

This creates a sample project, runs visual and accessibility tests, and generates reports automatically.

### Basic Usage

**Natural Language Commands:**
```bash
# Execute browser actions with natural language
iris run "click #submit-button"
iris run "fill #email with user@example.com"
iris run "navigate to https://example.com"

# AI-powered complex commands (requires API key)
export OPENAI_API_KEY=sk-your-key
iris run "find the blue button next to the search box and click it"
```

**Visual Regression Testing:**
```bash
# Compare current page against baseline
iris visual-diff \
  --pages "http://localhost:8080/**/*.html" \
  --baseline main \
  --devices desktop,tablet,mobile \
  --threshold 0.1 \
  --format html

# Enable AI semantic analysis
iris visual-diff \
  --pages "http://localhost:8080/" \
  --semantic \
  --threshold 0.1
```

**Accessibility Testing:**
```bash
# Run WCAG 2.1 AA compliance tests
iris a11y \
  --pages "http://localhost:8080/**/*.html" \
  --tags wcag2a,wcag2aa \
  --include-keyboard \
  --format html

# Test with screen reader simulation
iris a11y \
  --pages "http://localhost:8080/" \
  --include-screenreader \
  --fail-on critical,serious
```

**File Watching:**
```bash
# Watch files and auto-execute on changes
iris watch src/ --instruction "reload page"
iris watch "**/*.ts" --execute
```

**JSON-RPC Server:**
```bash
# Start WebSocket server for AI coding assistant integration
iris connect
iris connect 8080  # Custom port
```

---

## Configuration

### AI Provider Setup

**OpenAI (Recommended for Visual Analysis):**
```bash
export OPENAI_API_KEY=sk-your-key
```

**Anthropic Claude (Recommended for Semantic Analysis):**
```bash
export ANTHROPIC_API_KEY=sk-ant-your-key
```

**Local Ollama (Privacy-Focused):**
```bash
export OLLAMA_ENDPOINT=http://localhost:11434
export OLLAMA_MODEL=llava:latest
```

### Config File

Create `~/.iris/config.json`:
```json
{
  "ai": {
    "provider": "openai",
    "model": "gpt-4o-mini"
  },
  "visual": {
    "threshold": 0.1,
    "devices": ["desktop"],
    "aiProvider": "openai"
  },
  "accessibility": {
    "wcagLevel": "AA",
    "includeKeyboard": true
  },
  "watch": {
    "patterns": ["**/*.{ts,tsx,js,jsx}"],
    "debounceMs": 1000
  }
}
```

### Project-Level Config

Create `.irisrc` in your project root:
```json
{
  "visual": {
    "threshold": 0.1,
    "devices": ["desktop", "tablet", "mobile"],
    "capture": {
      "waitForFonts": true,
      "disableAnimations": true,
      "stabilizationDelay": 500
    }
  },
  "accessibility": {
    "wcagLevel": "AA",
    "includeKeyboard": true
  }
}
```

---

## Visual Regression Testing

### Features

**Capture Engine:**
- Screenshot capture with viewport/fullPage modes
- Multi-device support (desktop 1920x1080, tablet 768x1024, mobile 375x667)
- Page stabilization (fonts, animations, network idle)
- Dynamic content masking
- Element-specific capture

**Diff Engine:**
- Pixel-level comparison with pixelmatch
- SSIM (Structural Similarity Index) analysis
- Region-based difference detection
- Change classification (layout/content/styling/animation)

**AI Semantic Analysis:**
- OpenAI GPT-4 Vision integration
- Anthropic Claude 3.5 Sonnet support
- Ollama local model support
- Semantic change understanding (intentional vs regression)
- Severity classification (breaking, moderate, minor)
- Confidence scoring and explanations

**Baseline Management:**
- Git-integrated baseline storage
- Branch-based baseline strategies
- Commit-based snapshots
- Timestamp-based baselines
- Automatic cleanup of old baselines

**Reporting:**
- Interactive HTML reports with diff viewer
- JSON structured data export
- JUnit XML for CI/CD integration
- Markdown summary reports

### CLI Options

```bash
iris visual-diff [options]

Options:
  --pages <patterns>       Page patterns (comma-separated, default: /)
  --baseline <reference>   Baseline branch/commit (default: main)
  --semantic              Enable AI semantic analysis
  --threshold <value>     Pixel threshold 0-1 (default: 0.1)
  --devices <list>        Devices: desktop,tablet,mobile (default: desktop)
  --format <type>         Output: html|json|junit|markdown (default: html)
  --output <path>         Output file path
  --fail-on <severity>    Fail on: minor|moderate|breaking (default: breaking)
  --update-baseline       Update baseline with current screenshots
  --mask <selectors>      CSS selectors to mask (comma-separated)
  --concurrency <n>       Max concurrent comparisons (default: 3)
  --base-url <url>        Origin for relative --pages (default: http://localhost:3000)
  --show-cost             Print a read-only AI cost/cache summary after the run
```

**Base URL:** Relative `--pages` patterns (e.g. `/about`) resolve against
`--base-url`, or the `IRIS_BASE_URL` environment variable when the flag is
absent (flag takes precedence). When neither is set, the default origin is
`http://localhost:3000`. Absolute URLs in `--pages` always pass through
unchanged. The same `--base-url` flag and `IRIS_BASE_URL` env var apply to
`iris a11y`.

---

## Accessibility Testing

### Features

**WCAG Compliance:**
- WCAG 2.0/2.1 Level A, AA, AAA validation
- axe-core integration with 90+ rules
- Configurable rule sets and tags
- Impact-based severity classification

**Keyboard Navigation:**
- Tab order validation
- Focus trap detection
- Arrow key navigation testing
- Escape key handling verification
- Custom keyboard sequence testing

**Screen Reader Support:**
- ARIA label validation
- Landmark navigation testing
- Heading structure verification
- Image alt text validation
- Screen reader simulation

**Reporting:**
- Accessibility score (0-100 scale)
- Violation breakdown by severity
- Element-level issue reporting
- Remediation suggestions

### CLI Options

```bash
iris a11y [options]

Options:
  --pages <patterns>        Page patterns (comma-separated, default: /)
  --rules <rules>           Specific axe rules (comma-separated)
  --tags <tags>             Rule tags: wcag2a,wcag2aa,wcag21aa (default: wcag2a,wcag2aa)
  --fail-on <impacts>       Impact levels: critical,serious,moderate,minor (default: critical,serious)
  --format <type>           Output: html|json|junit (default: html)
  --output <path>           Output file path
  --include-keyboard        Include keyboard navigation tests (default: true)
  --include-screenreader    Include screen reader simulation
  --base-url <url>          Origin for relative --pages (default: http://localhost:3000)
```

---

## Examples

Pre-built examples are available in the `examples/` directory:

### 1. Basic Visual Testing
```bash
cd examples/basic-visual-test
./test-visual.sh
```

Demonstrates:
- Simple page comparison
- Baseline creation and updating
- Threshold configuration
- HTML report generation

### 2. Multi-Device Testing
```bash
cd examples/multi-device-visual
./test-responsive.sh
```

Demonstrates:
- Desktop, tablet, mobile testing
- Responsive design validation
- Device-specific baselines
- Parallel test execution

### 3. Accessibility Audit
```bash
cd examples/accessibility-audit
./test-a11y.sh
```

Demonstrates:
- WCAG 2.1 AA compliance testing
- Keyboard navigation validation
- Screen reader simulation
- Accessibility score reporting

### 4. CI/CD Integration
```bash
cd examples/ci-cd-integration
```

Includes configurations for:
- GitHub Actions
- GitLab CI
- Jenkins
- CircleCI

---

## Development

### Run Tests

```bash
npm test
# Result: 575/576 passing (99.8% pass rate)
# 0 failing
# 1 skipped
```

### Build

```bash
npm run build
```

### Coverage

```bash
npm test -- --coverage
# Overall: 75.7% statements (below 85% target)
# Branch coverage: 57.34% (primary improvement area)
```

### Run Benchmarks

```bash
npm run bench
```

Performance baselines:
- Single page visual diff: 42.61ms (target <100ms) ✅
- 4K image processing: 205.30ms (target <300ms) ✅
- Memory delta: 1.57MB ✅

---

## Architecture

### Phase 1 Core (9 modules, 25,667+ lines)

**CLI Framework** (`src/cli.ts`)
- Commander.js-based CLI with 5 commands
- Browser execution integration
- Configuration management

**Browser Automation** (`src/browser.ts`, `src/executor.ts`)
- Playwright wrapper with retry logic
- Action execution with error handling
- Session management

**AI Translation** (`src/translator.ts`, `src/ai-client.ts`)
- Pattern matching + AI fallback
- Multi-provider support (OpenAI/Anthropic/Ollama)
- Confidence scoring

**Protocol & Storage** (`src/protocol.ts`, `src/db.ts`)
- JSON-RPC 2.0 over WebSocket
- SQLite persistence with migration system
- Test result tracking with visual and a11y results

### Phase 2 Visual & Accessibility (In Progress)

**Visual Module** (`src/visual/`)
- `visual-runner.ts` - Test orchestration (15,365 bytes)
- `capture.ts` - Screenshot capture with stabilization
- `diff.ts` - Pixel and SSIM comparison
- `baseline.ts` - Git-integrated baseline management
- `ai-classifier.ts` - AI semantic analysis (6,843 bytes)
- `reporter.ts` - Multi-format reporting (979 lines)
- `storage.ts` - Artifact storage

**Accessibility Module** (`src/a11y/`)
- `a11y-runner.ts` - Test orchestration (12,799 bytes)
- `axe-integration.ts` - WCAG compliance (6,279 bytes)
- `keyboard-tester.ts` - Keyboard navigation (12,271 bytes)

**Database** (`src/db.ts`)
- Extended schema with visual_test_results and a11y_test_results tables
- Migration system for schema versioning
- Aggregate statistics and query functions

---

## Documentation

### Getting Started
- **[docs/GETTING_STARTED_GUIDE.md](docs/GETTING_STARTED_GUIDE.md)** - Complete setup guide (5-minute quick start, 20-minute full setup)
- **[docs/QUICKSTART.md](docs/QUICKSTART.md)** - 5-minute introduction

### API Reference
- **[docs/api/visual-testing.md](docs/api/visual-testing.md)** - Visual regression API (1,116 lines)
- **[docs/api/accessibility-testing.md](docs/api/accessibility-testing.md)** - Accessibility API (1,050 lines)

### Guides
- **[docs/guides/ci-cd-integration.md](docs/guides/ci-cd-integration.md)** - CI/CD integration (645 lines)
- **[docs/PERFORMANCE.md](docs/PERFORMANCE.md)** - Performance benchmarks and optimization
- **[docs/OPTIMIZATION_RECOMMENDATIONS.md](docs/OPTIMIZATION_RECOMMENDATIONS.md)** - Optimization strategies

### Development
- **[docs/DEVELOPMENT_INSTRUCTIONS.md](docs/DEVELOPMENT_INSTRUCTIONS.md)** - Development guide
- **[docs/phase2_technical_architecture.md](docs/phase2_technical_architecture.md)** - Phase 2 architecture (2,556 lines)
- **[plans/README.md](plans/README.md)** - Active plan tracker and roadmap

### Contributing
- **[docs/GIT_COMMIT_GUIDE.md](docs/GIT_COMMIT_GUIDE.md)** - Commit instructions

> Historical phase reports and assessments live in [docs/archive/](docs/archive/).

### AI Agents
- **[AGENT_INSTRUCTIONS.md](AGENT_INSTRUCTIONS.md)** - Development guidance
- **[CLAUDE.md](CLAUDE.md)** - Claude Code instructions
- **[docs/beads-migration-guide.md](docs/beads-migration-guide.md)** - Beads issue tracker guide

### Issue Tracking with Beads

IRIS uses **Beads** (`bd`) - a dependency-aware issue tracker designed for AI-supervised workflows. Issues are tracked with explicit dependency chains, making it easy for AI agents to find ready work and avoid duplicating effort.

**Quick Start:**
```bash
# Show unblocked issues ready to work on
bd ready

# View issue details
bd show iris-7

# Claim work
bd update iris-7 --status in_progress --assignee your-name

# Close when complete
bd close iris-7 --reason "commit abc123"
```

**Current Status:**
- **19 issues** tracking Phase 2 Sub-Phases B-E (weeks 5-18)
- **10 issues** ready with no blockers
- **Critical path**: iris-6 → iris-7 (P0 validation) → iris-8 → ... → iris-16

**Key Features:**
- Dependency tracking (`blocks`, `parent-child`, `discovered-from`)
- Auto-sync with git (JSONL export/import)
- Priority-based work queues (P0-P3)
- JSON output for programmatic access

See **[docs/beads-migration-guide.md](docs/beads-migration-guide.md)** for complete workflow documentation.

---

## Roadmap

### Phase 1 ✅ (Complete - September 2024)
- CLI framework with natural language commands
- Browser automation with Playwright
- File watching and auto-execution
- AI translation with multi-provider support
- JSON-RPC protocol server
- SQLite persistence

### Phase 2 🚧 (In Progress)
- ✅ Visual regression testing with pixel and SSIM comparison
- ✅ AI semantic analysis (OpenAI, Claude, Ollama)
- ✅ AI vision foundation with cost control and caching
- ✅ Multi-device testing (desktop, tablet, mobile)
- ✅ Accessibility validation (WCAG 2.1 AA/AAA)
- ✅ Keyboard navigation and screen reader testing
- ✅ Git-integrated baseline management
- ✅ Multi-format reporting (HTML, JSON, JUnit, Markdown)
- ✅ CLI integration (`iris visual-diff`, `iris a11y`)
- ✅ E2E integration tests
- ✅ Performance benchmarks
- ✅ Comprehensive documentation and examples
- ✅ CI/CD ready
- ✅ Test suite stabilized (99.8% pass rate, 0 failing)
- ⚠️ Coverage at 75.7% (below 85% target - branch coverage improvement needed)
- ⚠️ Some `src/a11y/index.ts` convenience wrappers still stubbed

### Phase 3 📋 (Planned - Q1 2026)
- Performance monitoring and Core Web Vitals
- Advanced AI-powered visual analysis
- Autonomous UI exploration
- Design system compliance checking
- Visual regression history and trends
- Team collaboration features

---

## Testing

**Test Coverage:**
- Total: 576 tests (575 passing, 99.8% pass rate)
- Failing: 0
- Skipped: 1
- Overall coverage: 75.7% statements (target: 85%)
  - Branch coverage: 57.34% (primary improvement opportunity)

_Metrics last verified: 2026-06-26_

**Test Suites:**
- Unit tests for all core modules
- Integration tests for CLI commands
- E2E tests: visual and accessibility suites passing (1 visual case skipped)
- Browser automation tests with real Playwright
- Performance benchmarks

---

## Dependencies

**Core:**
- Node.js >=20.0.0
- TypeScript 5.1.6
- Playwright 1.35.0
- Commander 11.0.0

**Visual Testing:**
- sharp (image processing)
- pixelmatch (pixel diff)
- image-ssim (structural similarity)
- simple-git (baseline management)
- openai (GPT-4 Vision)
- @anthropic-ai/sdk (Claude)

**Accessibility:**
- @axe-core/playwright
- pa11y

**Utilities:**
- zod (runtime validation)
- better-sqlite3 (database)
- ws (WebSocket)

---

## Performance

**Benchmarks (October 2025):**
- Single page visual diff: **42.61ms** (target <100ms) ✅ 57% better
- 4K image processing: **205.30ms** (target <300ms) ✅ 32% better
- Memory usage: **1.57MB delta** ✅ Excellent
- Parallel efficiency: 1.6x (roadmap for 3-5x improvement)

See [docs/PERFORMANCE.md](docs/PERFORMANCE.md) for detailed benchmarks.

---

## CI/CD Integration

IRIS is CI/CD ready with:
- Exit code propagation for pass/fail
- JUnit XML report generation
- JSON structured output
- Parallel test execution
- Configurable failure thresholds

**Example GitHub Actions:**
```yaml
- name: Visual Regression Testing
  run: |
    iris visual-diff \
      --pages "http://localhost:8080/**/*.html" \
      --baseline main \
      --format junit \
      --output test-results/visual.xml

- name: Accessibility Testing
  run: |
    iris a11y \
      --pages "http://localhost:8080/**/*.html" \
      --format junit \
      --output test-results/a11y.xml
```

See [docs/guides/ci-cd-integration.md](docs/guides/ci-cd-integration.md) for complete examples.

---

## Contributing

Phase 2 is complete. The project is ready for Phase 3 development or community contributions.

**Areas for Contribution:**
- Additional AI provider integrations
- Enhanced report visualizations
- Performance optimizations
- Additional accessibility rules
- Documentation improvements
- Example projects

See [DEVELOPMENT_INSTRUCTIONS.md](docs/DEVELOPMENT_INSTRUCTIONS.md) for contribution guidelines.

---

## License

MIT

---

## Links

- **GitHub:** [github.com/frankbria/iris](https://github.com/frankbria/iris)
- **Issues:** [github.com/frankbria/iris/issues](https://github.com/frankbria/iris/issues)
- **Twitter:** [@FrankBria18044](https://twitter.com/FrankBria18044)

Building in public. Star the repo to follow along! ⭐

---

## Quick Reference

**Installation:**
```bash
npm install -g iris-suite  # Coming soon to npm
# Or install from source:
git clone https://github.com/frankbria/iris.git && cd iris && npm install && npm run build && npm link
```

**Visual Testing:**
```bash
iris visual-diff --pages "http://localhost:8080/" --semantic
```

**Accessibility Testing:**
```bash
iris a11y --pages "http://localhost:8080/" --include-keyboard
```

**Get Help:**
```bash
iris --help
iris visual-diff --help
iris a11y --help
```

**Documentation:**
- Quick Start: [docs/GETTING_STARTED_GUIDE.md](docs/GETTING_STARTED_GUIDE.md)
- API Reference: [docs/api/](docs/api/)
- Examples: [examples/](examples/)

**Status:**
- Phase 1: ✅ Complete
- Phase 2: 🚧 In Progress (visual regression complete; a11y integration ongoing)
- Tests: 575/576 passing (99.8%), 1 skipped, 0 failing
- Coverage: 75.7% statements (below 85% target)
