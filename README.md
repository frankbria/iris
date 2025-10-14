# IRIS - Interface Recognition & Interaction Suite

> 👁️ AI-powered UI understanding and testing toolkit

**Phase 1: ✅ Complete** | **Phase 2: 🟡 40% Complete (AI Vision Foundation Complete)**

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

**Test Status:** 122/122 tests passing (100%)

### 🟡 Phase 2 - Visual Regression & Accessibility (40% Complete)

**✅ Sub-Phase 2A Complete: AI Vision Foundation (Week 1-4)**
- ✅ Multimodal AI client architecture (text + vision)
- ✅ Vision provider integrations (OpenAI GPT-4o, Anthropic Claude 3.5, Ollama)
- ✅ Image preprocessing pipeline (resize, optimize, base64 encoding)
- ✅ AI vision result caching (LRU memory + SQLite persistence)
- ✅ Cost tracking with budget management and circuit breaker
- ✅ Smart client with automatic fallback and cost optimization

**✅ Phase 2 Core Infrastructure (Week 1-2)**
- ✅ Visual capture engine with page stabilization
- ✅ SSIM and pixel-based diff engine
- ✅ Git-integrated baseline manager
- ✅ Complete TypeScript/Zod type system
- ✅ Database schema for visual testing

**Test Status:** 360/362 tests passing (99.4% - 2 skipped pending implementation)

**🚧 In Progress: Sub-Phase 2B - Visual Classification Integration (Week 5-7)**
- ⏳ AI visual classifier implementation
- ⏳ Diff engine integration with AI classification
- ⏳ Validation harness & golden dataset

**NOT IMPLEMENTED (Remaining 60%):**
- ❌ CLI integration (`iris visual-diff`, `iris a11y`)
- ❌ HTML/JUnit report generation
- ❌ Accessibility testing (axe-core integration)
- ❌ E2E orchestration pipeline
- ❌ Performance optimization

---

## Quick Start

### Installation

```bash
git clone https://github.com/frankbria/iris.git
cd iris
npm install
npm run build
```

### Basic Usage

**Natural Language Commands:**
```bash
# Execute browser actions with natural language
npm start run "click #submit-button"
npm start run "fill #email with user@example.com"
npm start run "navigate to https://example.com"

# AI-powered complex commands (requires API key)
export OPENAI_API_KEY=sk-your-key
npm start run "find the blue button next to the search box and click it"
```

**File Watching:**
```bash
# Watch files and auto-execute on changes
npm start watch src/ --instruction "reload page"
npm start watch "**/*.ts" --execute
```

**JSON-RPC Server:**
```bash
# Start WebSocket server for AI coding assistant integration
npm start connect
npm start connect 8080  # Custom port
```

---

## Configuration

### AI Provider Setup

**OpenAI (Recommended):**
```bash
export OPENAI_API_KEY=sk-your-key
```

**Anthropic Claude:**
```bash
export ANTHROPIC_API_KEY=sk-ant-your-key
```

**Local Ollama:**
```bash
export OLLAMA_ENDPOINT=http://localhost:11434
export OLLAMA_MODEL=llama2
```

### Config File

Create `~/.iris/config.json`:
```json
{
  "ai": {
    "provider": "openai",
    "model": "gpt-4o-mini"
  },
  "watch": {
    "patterns": ["**/*.{ts,tsx,js,jsx}"],
    "debounceMs": 1000
  }
}
```

---

## Phase 2 Features (Visual Regression & Accessibility)

### Visual Regression Testing (Core Implemented)

**Capture Engine:**
- Screenshot capture with viewport/fullPage modes
- Element-specific capture
- Page stabilization (fonts, animations, network idle)
- Dynamic content masking

**Diff Engine:**
- Pixel-level comparison with pixelmatch
- SSIM (Structural Similarity Index) analysis
- Region-based difference detection
- Change classification (layout/content/styling/animation)

**Baseline Manager:**
- Git-integrated baseline storage
- Branch-based baseline isolation
- Automatic cleanup of old baselines

**NOT IMPLEMENTED (Coming in Future Releases):**
- ❌ AI-powered semantic analysis of visual changes - NOT IMPLEMENTED
- ❌ CLI commands: `iris visual-diff` - NOT IMPLEMENTED
- ❌ HTML/JUnit report generation - NOT IMPLEMENTED

### Accessibility Testing (NOT IMPLEMENTED)

**Planned Features (NOT YET STARTED):**
- ❌ WCAG 2.1 AA compliance validation with axe-core - NOT IMPLEMENTED
- ❌ Keyboard navigation testing - NOT IMPLEMENTED
- ❌ Screen reader simulation - NOT IMPLEMENTED
- ❌ Color contrast validation - NOT IMPLEMENTED
- ❌ CLI command: `iris a11y` - NOT IMPLEMENTED

---

## Development

### Run Tests

```bash
npm test
# Expected: 221 passing, 2 skipped
```

### Build

```bash
npm run build
```

### Coverage

```bash
npm test -- --coverage
```

---

## Architecture

### Phase 1 Core (9 modules, 25,667+ lines)

**CLI Framework** (`src/cli.ts`)
- Commander.js-based CLI with 3 commands
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
- SQLite persistence
- Test result tracking

### Phase 2 Visual & Accessibility (Partial)

**Visual Module** (`src/visual/`)
- Capture engine (200 lines)
- Diff engine (310 lines)
- Baseline manager (299 lines)
- Type system with Zod validation

**Accessibility Module** (`src/a11y/`)
- Type definitions (complete)
- Implementation pending

**Utilities** (`src/utils/`)
- Database migration system
- Shared types and helpers

---

## Documentation

**For Developers:**
- [docs/DEVELOPMENT_INSTRUCTIONS.md](docs/DEVELOPMENT_INSTRUCTIONS.md) - Comprehensive development guide
- [docs/CODEBASE_ANALYSIS_SUMMARY.md](docs/CODEBASE_ANALYSIS_SUMMARY.md) - Complete analysis
- [docs/phase2_technical_architecture.md](docs/phase2_technical_architecture.md) - Phase 2 design (2,556 lines)
- [docs/PROJECT_INDEX.md](docs/PROJECT_INDEX.md) - Project navigation guide

**For Contributors:**
- [plan/READY_FOR_COMMIT.md](plan/READY_FOR_COMMIT.md) - Git workflow guide
- [docs/GIT_COMMIT_GUIDE.md](docs/GIT_COMMIT_GUIDE.md) - Commit instructions
- [plan/phase2_todo.md](plan/phase2_todo.md) - Remaining tasks

**For AI Agents:**
- [AGENT_INSTRUCTIONS.md](AGENT_INSTRUCTIONS.md) - Step-by-step development guidance
- [CLAUDE.md](CLAUDE.md) - Claude Code specific instructions

---

## Roadmap

### Phase 1 ✅ (Complete)
- CLI framework with natural language commands
- Browser automation with Playwright
- File watching and auto-execution
- AI translation with multi-provider support
- JSON-RPC protocol server
- SQLite persistence

### Phase 2 🟡 (25% Complete - Q1-Q2 2026, 14-18 weeks)
- Visual regression testing core modules (PARTIAL ✅)
- ❌ AI vision integration with cost control (NOT IMPLEMENTED - Sub-Phase 2A)
- ❌ Validation harness with golden dataset (NOT IMPLEMENTED - Sub-Phase 2B)
- ❌ Parallel execution & performance optimization (NOT IMPLEMENTED - Sub-Phase 2C)
- ❌ CLI integration & reporting (NOT IMPLEMENTED - Sub-Phase 2D)
- ❌ Accessibility foundation (NOT IMPLEMENTED - Sub-Phase 2E)

**📋 See [docs/PHASE2_README.md](docs/PHASE2_README.md) for complete Phase 2 documentation guide**

### Phase 3 📋 (Planned - Q3 2026)
- Performance monitoring
- Advanced AI-powered visual analysis
- Autonomous UI exploration
- Design system compliance checking

---

## Testing

**Test Coverage:**
- Phase 1: 122/122 tests (100%)
- Phase 2: 178/180 tests (99%)
- **Overall: 300/302 tests passing (99.3%)**

**Test Suites:**
- Unit tests for all core modules
- Integration tests for full workflows
- Browser automation tests with real Playwright

---

## Dependencies

**Core:**
- Node.js >=18.0.0
- TypeScript 5.1.6
- Playwright 1.35.0
- Commander 11.0.0

**Phase 2:**
- sharp (image processing)
- pixelmatch (pixel diff)
- image-ssim (structural similarity)
- simple-git (baseline management)
- @axe-core/playwright (accessibility)
- zod (runtime validation)

---

## Contributing

This project is in active development. Phase 2 implementation is ongoing.

**Current Focus:**
- AI visual classification integration
- CLI command implementation for visual testing
- Report generation system
- Accessibility testing modules

See [DEVELOPMENT_INSTRUCTIONS.md](DEVELOPMENT_INSTRUCTIONS.md) for detailed contribution guidelines.

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

## Quick Links

**Get Started:**
- Installation: See [Quick Start](#quick-start)
- First Command: `npm start run "click #button"`
- Configuration: See [Configuration](#configuration)

**Development:**
- Guide: [docs/DEVELOPMENT_INSTRUCTIONS.md](docs/DEVELOPMENT_INSTRUCTIONS.md)
- Architecture: [docs/phase2_technical_architecture.md](docs/phase2_technical_architecture.md)
- Tasks: [plan/phase2_todo.md](plan/phase2_todo.md)

**Status:**
- Phase 1: ✅ Complete
- Phase 2: 🟡 25% Complete (Core Only)
- Tests: 300/302 passing (99.3%)
