# IRIS Development Instructions
**Version:** 2.0 (Phase 2 Partial Implementation)
**Date:** September 30, 2025
**Status:** Ready for Git Commit & Continued Development

---

## Executive Summary

IRIS (Interface Recognition & Interaction Suite) is an AI-powered UI testing toolkit with robust Phase 1 foundations and partially implemented Phase 2 visual regression capabilities. The project is in a stable state for git commit with clear paths for continued development.

### Current Implementation Status

**✅ Phase 1: COMPLETE (Production-Ready)**
- **Test Status:** 221/223 tests passing (99.1% success rate, 2 skipped tests)
- **Core Modules:** 9 TypeScript modules with comprehensive browser automation
- **CLI Commands:** `run`, `watch`, `connect` fully operational
- **Quality:** Production-ready error handling, retry logic, session management

**🟡 Phase 2: Core Infrastructure Complete (~40% Implementation)**
- **Visual Testing:** Capture, Diff, and Baseline engines implemented
- **Type System:** Complete TypeScript/Zod schemas with validation
- **Database:** Migration system ready, schema extensions complete
- **Dependencies:** All required packages installed and working

**🔴 Phase 2: Remaining Work**
- AI visual classification integration
- CLI command integration (`iris visual-diff`, `iris a11y`)
- HTML/JUnit report generation
- Accessibility testing modules (axe-core integration)
- Full end-to-end orchestration

---

## Project Architecture

### Directory Structure

```
iris/
├── src/                      # Source code (9 core modules + Phase 2)
│   ├── cli.ts               # ✅ CLI entry point (198 lines)
│   ├── executor.ts          # ✅ Action execution engine (243 lines)
│   ├── browser.ts           # ✅ Playwright wrapper (61 lines)
│   ├── translator.ts        # ✅ NL to action translation (174 lines)
│   ├── protocol.ts          # ✅ JSON-RPC WebSocket server (297 lines)
│   ├── ai-client.ts         # ✅ Multi-provider AI integration (5,734+ lines)
│   ├── config.ts            # ✅ Configuration management (3,423+ lines)
│   ├── db.ts               # ✅ SQLite persistence (1,838+ lines)
│   ├── watcher.ts          # ✅ File watching system (13,907+ lines)
│   │
│   ├── visual/             # 🟡 Visual regression module (40% complete)
│   │   ├── index.ts        # ✅ Public API exports
│   │   ├── types.ts        # ✅ TypeScript/Zod schemas
│   │   ├── capture.ts      # ✅ Screenshot capture engine (200 lines)
│   │   ├── diff.ts         # ✅ Visual diff engine (310 lines)
│   │   └── baseline.ts     # ✅ Git-integrated baseline manager (299 lines)
│   │
│   ├── a11y/               # ✅ Accessibility types (implementation pending)
│   │   ├── index.ts        # ✅ Public API exports
│   │   └── types.ts        # ✅ Accessibility type definitions
│   │
│   └── utils/              # ✅ Shared utilities (basic structure)
│       ├── index.ts        # ✅ Public API exports
│       ├── types.ts        # ✅ Utility type definitions
│       └── migration.ts    # ✅ Database migration system
│
├── __tests__/              # Test suites (17 suites, 221 passing)
│   ├── [Phase 1 tests]    # ✅ 10 test suites (100% passing)
│   ├── visual/            # ✅ 4 test suites (100% passing)
│   ├── a11y/              # ✅ 1 test suite (types only)
│   └── utils/             # ✅ 2 test suites (100% passing)
│
├── docs/                   # Comprehensive documentation
│   ├── prd.md             # Product requirements
│   ├── dev_plan.md        # Development plan
│   ├── tech_specs.md      # Technical specifications
│   └── phase2_technical_architecture.md  # Phase 2 detailed design
│
├── plan/                   # Development planning
│   ├── phase1_todo.md     # Phase 1 task tracking (COMPLETE)
│   ├── phase2_todo.md     # Phase 2 task tracking (IN PROGRESS)
│   └── status_*.md        # Historical status reports
│
├── coverage/              # Test coverage reports
├── dist/                  # Compiled TypeScript output
└── [config files]        # package.json, tsconfig.json, jest.config.ts
```

### Technology Stack

**Runtime & Core:**
- Node.js >=18.0.0
- TypeScript 5.1.6 (strict mode)
- Playwright 1.35.0 (browser automation)
- Commander 11.0.0 (CLI framework)

**Phase 1 Dependencies:**
- better-sqlite3: Database persistence
- chokidar: File watching
- openai: AI translation
- ws: WebSocket protocol

**Phase 2 Dependencies:**
- sharp: High-performance image processing
- pixelmatch: Pixel-level diff detection
- image-ssim: Structural similarity comparison
- simple-git: Git integration for baselines
- @axe-core/playwright: Accessibility testing
- zod: Runtime type validation

**Testing:**
- Jest + ts-jest (17 test suites, 221/223 passing)

---

## Phase 1 Implementation (COMPLETE)

### Working Features

**1. CLI Commands**
```bash
# Execute natural language commands
npm start run "click #submit-button"
npm start run "type 'hello' into #input-field"

# File watching with auto-execution
npm start watch --execute "click #refresh"

# JSON-RPC WebSocket server
npm start connect [port]
```

**2. Action Execution System**
- Location: `src/executor.ts:243`
- Retry logic with exponential backoff
- Page context management
- Browser lifecycle handling
- Error recovery and cleanup

**3. Multi-Provider AI Integration**
- OpenAI, Anthropic, Ollama support
- Pattern matching fallback
- Confidence scoring
- Context-aware translation

**4. Database Persistence**
- SQLite storage with execution history
- Result tracking with timestamps
- Migration system ready

### Key Implementation Files

**ActionExecutor** (`src/executor.ts`)
```typescript
class ActionExecutor {
  executeAction(action: Action, page: Page): Promise<ActionResult>
  executeActions(actions: Action[], page: Page): Promise<ActionResult[]>
  // Comprehensive retry logic and error handling
}
```

**AI Translation** (`src/translator.ts`)
```typescript
class Translator {
  translateInstruction(instruction: string): Promise<TranslationResult>
  // Pattern matching + AI fallback
}
```

**Protocol Server** (`src/protocol.ts`)
```typescript
class ProtocolServer {
  executeBrowserAction(instruction): Promise<Result>
  // WebSocket server with browser session management
}
```

---

## Phase 2 Implementation (40% Complete)

### Implemented Components

**1. Visual Capture Engine** (`src/visual/capture.ts`)
```typescript
class VisualCaptureEngine {
  async capture(page: Page, config: CaptureConfig): Promise<CaptureResult>
  // ✅ Screenshot capture with stabilization
  // ✅ Element masking for dynamic content
  // ✅ Animation disabling
  // ✅ Network idle detection
}
```

**2. Visual Diff Engine** (`src/visual/diff.ts`)
```typescript
class VisualDiffEngine {
  async compare(baseline: Buffer, current: Buffer, options: DiffOptions): Promise<DiffResult>
  async ssimCompare(baseline: Buffer, current: Buffer): Promise<SSIMResult>
  // ✅ Pixel-level comparison with pixelmatch
  // ✅ SSIM structural similarity
  // ✅ Region-based analysis
  // ✅ Change classification (layout/content/styling)
}
```

**3. Baseline Manager** (`src/visual/baseline.ts`)
```typescript
class BaselineManager {
  async saveBaseline(testName: string, imageBuffer: Buffer, metadata: BaselineMetadata): Promise<BaselineSaveResult>
  async loadBaseline(testName: string, branch?: string): Promise<BaselineLoadResult>
  // ✅ Git-integrated baseline storage
  // ✅ Branch-based baseline strategy
  // ✅ Baseline cleanup and maintenance
}
```

**4. Type System** (`src/visual/types.ts`)
- ✅ Comprehensive Zod schemas for validation
- ✅ CaptureConfig, DiffOptions, DiffResult interfaces
- ✅ BaselineMetadata and storage types
- ✅ Error classes for visual testing scenarios

**5. Database Schema** (`src/utils/migration.ts`)
- ✅ Migration system implemented
- ✅ Visual baselines table
- ✅ Visual comparisons table
- ✅ Region diffs table
- ✅ Accessibility results tables

### Remaining Work

**High Priority (Required for Phase 2 MVP)**

1. **AI Visual Classification** ⏳
   - File: `src/visual/ai-classifier.ts` (to be created)
   - Integrate OpenAI Vision API for semantic analysis
   - Implement fallback to rule-based classification
   - Add caching layer for AI responses
   - Reference: `docs/phase2_technical_architecture.md:2086-2293`

2. **CLI Integration** ⏳
   - Extend `src/cli.ts` with visual commands
   - Implement `iris visual-diff` command
   - Implement `iris a11y` command
   - Add `--visual` and `--a11y` flags to `iris run`
   - Reference: `docs/phase2_technical_architecture.md:1313-1525`

3. **Report Generation** ⏳
   - File: `src/visual/reporter.ts` (to be created)
   - HTML report generation with diff visualization
   - JSON export (basic implementation exists)
   - JUnit XML export for CI/CD
   - Reference: `docs/phase2_technical_architecture.md` (reporting section)

4. **Visual Test Orchestration** ⏳
   - File: `src/visual/visual-runner.ts` (to be created)
   - End-to-end test execution pipeline
   - Multi-page test coordination
   - Result aggregation and summary
   - Reference: `docs/phase2_technical_architecture.md:1781-1928`

**Medium Priority (Accessibility Testing)**

5. **Accessibility Module** 📋
   - Files: `src/a11y/*.ts` (structure exists, implementation needed)
   - axe-core integration (`src/a11y/axe-runner.ts`)
   - Keyboard navigation testing (`src/a11y/keyboard-tester.ts`)
   - Screen reader simulation (`src/a11y/screenreader-sim.ts`)
   - Reference: `docs/phase2_technical_architecture.md:933-1049`

**Lower Priority (Enhancement)**

6. **Performance Optimization** 🎯
   - Image caching with LRU cache
   - Concurrent processing optimization
   - Memory management improvements
   - AI request rate limiting
   - Reference: `docs/phase2_technical_architecture.md:1717-2081`

7. **Documentation & Examples** 📚
   - API documentation for visual testing
   - Configuration guide
   - CI/CD integration examples
   - Troubleshooting guide

---

## Development Workflow

### Getting Started

**1. Install Dependencies**
```bash
npm install
```

**2. Build TypeScript**
```bash
npm run build
```

**3. Run Tests**
```bash
npm test
# Expected: 221 passing, 2 skipped (out of 223 total)
```

**4. Start Development**
```bash
# Run CLI in development mode
npm start run "your instruction"

# Watch file changes
npm start watch [target]

# Start protocol server
npm start connect [port]
```

### Test-Driven Development

**Writing Tests** (Follow TDD Approach)

1. **Create test file first** in `__tests__/[module]/`
2. **Write failing tests** that describe desired behavior
3. **Implement minimum code** to pass tests
4. **Refactor** while keeping tests green

**Test Structure Example:**
```typescript
// __tests__/visual/ai-classifier.test.ts
import { AIVisualClassifier } from '../ai-classifier';

describe('AIVisualClassifier', () => {
  it('should classify intentional design changes', async () => {
    const classifier = new AIVisualClassifier(config);
    const result = await classifier.analyzeVisualChange(baseline, candidate);

    expect(result.classification).toBe('intentional');
    expect(result.confidence).toBeGreaterThan(0.8);
  });
});
```

**Current Test Status:**
- ✅ Phase 1: 122/122 tests passing (100%)
- ✅ Phase 2 Types: 17/17 tests passing (100%)
- ✅ Phase 2 Visual: 82/82 tests passing (100%)
- ⚠️ Total: 221/223 passing (2 skipped tests)

### Code Quality Standards

**TypeScript Standards:**
- Strict mode enabled (`tsconfig.json`)
- Comprehensive type definitions
- No implicit `any` types
- Proper async/await patterns

**Error Handling:**
- Try-catch blocks for all async operations
- Meaningful error messages
- Graceful degradation
- Proper resource cleanup

**Documentation:**
- JSDoc comments for public APIs
- Inline comments for complex logic
- README files for modules
- Architecture decision records (ADRs)

---

## Git Workflow & Commit Strategy

### Pre-Commit Checklist

Before committing to git:

**1. Run Tests**
```bash
npm test
# Ensure 221+ tests passing
```

**2. Build Project**
```bash
npm run build
# Verify TypeScript compilation
```

**3. Review Changes**
```bash
git status
git diff
```

**4. Stage Files Selectively**
```bash
# DO commit:
git add src/ __tests__/ docs/ plan/
git add package.json package-lock.json tsconfig.json jest.config.ts
git add DEVELOPMENT_INSTRUCTIONS.md

# DO NOT commit:
# - coverage/ (test coverage reports - regenerated)
# - dist/ (build output - regenerated)
# - node_modules/ (dependencies - installed via npm)
# - .env files (secrets)
```

### Recommended Commit Message

```
feat(phase2): implement visual regression core infrastructure

Phase 2 Status: ~40% Complete - Core Infrastructure Implemented

✅ Implemented:
- Visual capture engine with stabilization & masking
- Visual diff engine with SSIM & pixel comparison
- Git-integrated baseline manager
- Complete TypeScript/Zod type system
- Database migration framework
- Comprehensive test coverage (221/223 passing)

🔴 Remaining Work:
- AI visual classification integration
- CLI command implementation (visual-diff, a11y)
- HTML/JUnit report generation
- Accessibility testing modules
- Full E2E orchestration pipeline

Test Status: 221 passing, 2 skipped (99.1% pass rate)
Phase 1: 100% complete and stable
Phase 2: Core engines operational, integration pending

See DEVELOPMENT_INSTRUCTIONS.md for detailed continuation plan
```

### Branch Strategy (Recommended)

```bash
# Feature branch for Phase 2 work
git checkout -b feature/phase2-visual-regression

# Or separate branches for specific features
git checkout -b feature/ai-visual-classifier
git checkout -b feature/cli-visual-commands
git checkout -b feature/accessibility-testing
```

---

## Next Steps for Continued Development

### Immediate Priorities (Week 1-2)

**1. AI Visual Classifier Implementation**
```typescript
// File: src/visual/ai-classifier.ts

import { OpenAIClient } from '../ai-client';

export class AIVisualClassifier {
  constructor(private config: AIClassifierConfig) {}

  async analyzeVisualChange(
    baselineImage: Buffer,
    candidateImage: Buffer,
    context?: VisualAnalysisRequest
  ): Promise<VisualAnalysisResponse> {
    // TODO: Implement OpenAI Vision API integration
    // Reference: docs/phase2_technical_architecture.md:2202-2246

    // 1. Convert images to base64
    // 2. Construct analysis prompt
    // 3. Call OpenAI Vision API
    // 4. Parse and validate response
    // 5. Return classification with confidence
  }
}
```

**Integration Points:**
- Extend existing `src/ai-client.ts` OpenAIClient
- Add vision analysis method
- Implement caching layer
- Add fallback to rule-based analysis

**2. CLI Visual Commands**
```typescript
// File: src/cli.ts (extend existing)

program
  .command('visual-diff')
  .description('Run visual regression testing')
  .option('--pages <patterns>', 'Page patterns to test')
  .option('--baseline <reference>', 'Baseline branch', 'main')
  .option('--semantic', 'Enable AI analysis', false)
  .action(async (options) => {
    // TODO: Implement visual diff command
    // Reference: docs/phase2_technical_architecture.md:1313-1414

    const runner = new VisualTestRunner(options);
    const result = await runner.run();
    // Display results and exit with appropriate code
  });
```

**Required:**
- Create `VisualTestRunner` class
- Integrate capture → diff → report pipeline
- Handle exit codes (0=pass, 5=visual regression)
- Add progress indicators

### Short-Term Goals (Week 3-4)

**3. Report Generation System**
```typescript
// File: src/visual/reporter.ts

export class VisualReporter {
  async generateReport(
    results: DiffResult[],
    format: 'html' | 'json' | 'junit'
  ): Promise<string> {
    // TODO: Implement multi-format reports

    switch (format) {
      case 'html':
        return this.generateHTMLReport(results);
      case 'json':
        return this.generateJSONReport(results);
      case 'junit':
        return this.generateJUnitReport(results);
    }
  }
}
```

**4. Accessibility Testing Foundation**
```typescript
// File: src/a11y/axe-runner.ts

import { injectAxe, getViolations } from '@axe-core/playwright';

export class AxeRunner {
  async runAccessibilityTest(
    page: Page,
    url: string,
    config: AccessibilityConfig
  ): Promise<AccessibilityTestRun> {
    // TODO: Implement axe-core integration
    // Reference: docs/phase2_technical_architecture.md:933-1048

    await injectAxe(page);
    const violations = await getViolations(page, config.axe);
    return this.formatResults(violations);
  }
}
```

### Medium-Term Goals (Week 5-8)

**5. Performance Optimization**
- Implement concurrent processing with `p-limit`
- Add LRU cache for images and AI results
- Optimize memory usage with streaming
- Add performance monitoring

**6. Full E2E Testing**
- Create integration test suite
- Validate complete workflows
- Test CLI commands end-to-end
- Verify database migrations

**7. Documentation & Examples**
- Write API documentation
- Create usage examples
- Add troubleshooting guide
- Document configuration options

---

## Configuration Guide

### Environment Variables

```bash
# AI Provider Configuration
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-ant-..."

# Database
export IRIS_DB_PATH="./.iris/iris.sqlite"

# Visual Testing
export IRIS_BASELINE_DIR="./.iris/baselines"
export IRIS_ARTIFACTS_DIR="./.iris/artifacts"
```

### Configuration File

Create `iris.config.json`:

```json
{
  "ai": {
    "provider": "openai",
    "model": "gpt-4-vision-preview",
    "temperature": 0.1,
    "maxTokens": 1000
  },
  "visual": {
    "enabled": true,
    "baselineBranch": "main",
    "diffThreshold": 0.1,
    "semanticAnalysis": {
      "enabled": true,
      "provider": "openai"
    },
    "capture": {
      "viewport": { "width": 1920, "height": 1080 },
      "fullPage": true,
      "stabilization": {
        "delay": 500,
        "waitForFonts": true,
        "disableAnimations": true
      }
    }
  },
  "accessibility": {
    "enabled": true,
    "axe": {
      "tags": ["wcag2a", "wcag2aa", "wcag21aa"]
    },
    "failureThreshold": {
      "critical": true,
      "serious": true
    }
  }
}
```

---

## Troubleshooting Guide

### Common Issues

**1. Test Failures**
```bash
# Issue: 2 tests skipped
# Location: __tests__/visual/types.test.ts, __tests__/a11y/types.test.ts
# Solution: This is expected - implementation pending
```

**2. TypeScript Compilation Errors**
```bash
# Clear build cache
rm -rf dist/
npm run build
```

**3. Database Migration Issues**
```bash
# Reset database (development only)
rm ./.iris/iris.sqlite
npm start run "test command"  # Will recreate
```

**4. Missing Dependencies**
```bash
# Reinstall all dependencies
rm -rf node_modules/ package-lock.json
npm install
```

### Getting Help

**Documentation:**
- `/docs/prd.md` - Product requirements
- `/docs/tech_specs.md` - Technical specifications
- `/docs/phase2_technical_architecture.md` - Detailed Phase 2 design
- `/plan/phase2_todo.md` - Task tracking with status

**Support Resources:**
- GitHub Issues: https://github.com/frankbria/iris/issues
- Project README: `/README.md`
- Agent Instructions: `/AGENT_INSTRUCTIONS.md`

---

## Success Metrics

### Phase 2 Completion Criteria

**Technical Metrics:**
- [ ] Visual diff accuracy >95%
- [ ] Test coverage >90% for Phase 2 modules
- [ ] Processing time <10s for full-page visual diff
- [ ] All 221+ tests passing
- [ ] Zero Phase 1 regressions

**Feature Completeness:**
- [ ] `iris visual-diff` command operational
- [ ] `iris a11y` command operational
- [ ] AI visual classification working
- [ ] HTML/JSON/JUnit reports generating
- [ ] Accessibility testing complete

**Quality Gates:**
- [ ] Production-ready error handling
- [ ] Comprehensive documentation
- [ ] CI/CD integration examples
- [ ] Migration guides complete
- [ ] User acceptance validation

### Current Status Summary

**Overall Progress: 40% Complete**

**Phase 1:** ✅ 100% (Production-Ready)
- All core functionality implemented
- 122/122 tests passing
- Battle-tested and stable

**Phase 2:** 🟡 40% (Core Infrastructure Complete)
- ✅ Visual capture, diff, baseline engines
- ✅ Type system and database schema
- ✅ Test coverage for implemented features
- 🔴 AI integration, CLI, reporting pending

**Next Milestone:** 60% (AI + CLI Integration)
- Implement AI visual classifier
- Add visual-diff CLI command
- Create basic report generation

---

## Appendix

### File Reference Guide

**Core Phase 1 Files:**
- `src/cli.ts` - CLI entry point (198 lines)
- `src/executor.ts` - Action execution (243 lines)
- `src/browser.ts` - Playwright wrapper (61 lines)
- `src/translator.ts` - NL translation (174 lines)
- `src/protocol.ts` - WebSocket server (297 lines)
- `src/ai-client.ts` - AI integration (5,734+ lines)
- `src/config.ts` - Configuration (3,423+ lines)
- `src/db.ts` - Database layer (1,838+ lines)
- `src/watcher.ts` - File watching (13,907+ lines)

**Phase 2 Visual Testing:**
- `src/visual/capture.ts` - ✅ Screenshot capture (200 lines)
- `src/visual/diff.ts` - ✅ Visual comparison (310 lines)
- `src/visual/baseline.ts` - ✅ Baseline management (299 lines)
- `src/visual/types.ts` - ✅ Type definitions
- `src/visual/index.ts` - ✅ Public API exports
- `src/visual/ai-classifier.ts` - ⏳ TO BE IMPLEMENTED
- `src/visual/reporter.ts` - ⏳ TO BE IMPLEMENTED
- `src/visual/visual-runner.ts` - ⏳ TO BE IMPLEMENTED

**Phase 2 Accessibility:**
- `src/a11y/types.ts` - ✅ Type definitions
- `src/a11y/index.ts` - ✅ Public API exports
- `src/a11y/axe-runner.ts` - ⏳ TO BE IMPLEMENTED
- `src/a11y/keyboard-tester.ts` - ⏳ TO BE IMPLEMENTED
- `src/a11y/screenreader-sim.ts` - ⏳ TO BE IMPLEMENTED

**Documentation:**
- `docs/prd.md` - Product requirements
- `docs/dev_plan.md` - Development plan
- `docs/tech_specs.md` - Technical specs
- `docs/phase2_technical_architecture.md` - Phase 2 design (2,556 lines)

**Planning:**
- `plan/phase1_todo.md` - Phase 1 tasks (COMPLETE)
- `plan/phase2_todo.md` - Phase 2 tasks (IN PROGRESS)
- `plan/status_202509192120.md` - Latest status report

### Architecture Decision Records

**ADR-001: TypeScript Strict Mode**
- Decision: Use strict TypeScript compilation
- Rationale: Type safety, better IDE support, fewer runtime errors
- Status: Implemented

**ADR-002: Multi-Provider AI Architecture**
- Decision: Support OpenAI, Anthropic, Ollama with fallback
- Rationale: Flexibility, resilience, cost optimization
- Status: Phase 1 implemented, Phase 2 pending

**ADR-003: Git-Integrated Baseline Storage**
- Decision: Store baselines with git branch isolation
- Rationale: Natural workflow, version control integration
- Status: Implemented in BaselineManager

**ADR-004: Zod for Runtime Validation**
- Decision: Use Zod schemas for configuration validation
- Rationale: Type safety at runtime, better error messages
- Status: Implemented for Phase 2 types

**ADR-005: Jest with ts-jest for Testing**
- Decision: Jest as test framework with TypeScript support
- Rationale: Industry standard, good TypeScript integration
- Status: 17 test suites, 221/223 passing

---

## Quick Start Commands

```bash
# Install dependencies
npm install

# Build project
npm run build

# Run tests
npm test

# Start development CLI
npm start run "click #button"
npm start watch --execute "refresh page"
npm start connect 4000

# View test coverage
npm test -- --coverage

# Clean build
rm -rf dist/ && npm run build
```

---

**Document End**

*This file should be version controlled and updated as development progresses. It serves as the primary reference for developers continuing work on the IRIS project.*
