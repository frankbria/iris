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
│   ├── vision.ts          # Vision AI clients (GPT-4o, Claude 3.5, Ollama)
│   ├── preprocessor.ts    # Image preprocessing pipeline
│   ├── cache.ts           # LRU + SQLite caching system
│   ├── cost-tracker.ts    # Budget management and cost tracking
│   ├── smart-client.ts    # Smart client with fallback logic
│   ├── factory.ts         # Client factory with provider detection
│   └── index.ts           # Module exports
├── visual/                # Visual testing modules
│   ├── capture.ts         # Screenshot capture with stabilization
│   ├── diff.ts            # SSIM + pixel diff engine
│   └── baseline.ts        # Git-integrated baseline management
└── config.ts              # Configuration types and validation

__tests__/
├── cli.test.ts                    # CLI command testing
├── browser.test.ts                # Browser automation testing
├── ai-client.test.ts              # Text AI client tests
├── ai-client-vision.test.ts       # Vision AI client tests (17 tests)
├── ai-client-preprocessor.test.ts # Preprocessor tests (24 tests)
├── ai-client-batch4.test.ts       # Cache + cost tracker tests (19 tests)
└── visual/                        # Visual testing tests
    ├── capture.test.ts
    ├── diff.test.ts
    └── baseline.test.ts

migrations/
├── 001_initial_schema.sql         # Phase 1 database schema
└── 002_ai_cache_cost.sql          # AI cache + cost tracking tables

docs/                               # Detailed project documentation
├── prd.md                         # Product Requirements Document
├── tech_specs.md                  # Technical specifications
├── dev_plan.md                    # Development roadmap
├── user_stories.md                # User stories and acceptance criteria
├── PHASE2_README.md               # Phase 2 documentation guide
├── phase2_revised_plan.md         # Phase 2 strategy
├── phase2_technical_architecture.md # Phase 2 technical details
└── phase2_architecture_gaps.md    # Phase 2 gap analysis

plan/
└── phase2_todo.md                 # Active Phase 2 task tracker
```

## Development Guidelines

### Current Phase: Phase 2 - Visual Regression & Accessibility (50% Complete)

**Completed: Sub-Phase 2A - AI Vision Foundation (Week 1-4)**
1. ✅ Multimodal AI client architecture (text + vision capabilities)
2. ✅ Vision provider integrations (OpenAI GPT-4o, Anthropic Claude 3.5, Ollama llava)
3. ✅ Image preprocessing pipeline (resize, optimize, hash for caching)
4. ✅ AI vision result caching (LRU memory + SQLite persistence, 30-day TTL)
5. ✅ Cost tracking with budget management (daily/monthly limits, circuit breaker)
6. ✅ Smart client with automatic fallback (Ollama → OpenAI → Anthropic)

**Completed: Sub-Phase 2B - Visual Classification Integration (Week 5-6)**
1. ✅ AIVisualClassifier refactored to use Phase 2A infrastructure
2. ✅ Backward-compatible adapter pattern implementation
3. ✅ Comprehensive test suite (45 tests, 100% passing)
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
- **AIVisionCache**: Two-tier caching (LRU memory + SQLite), tracks hit rates, automatic TTL expiration
- **CostTracker**: Real-time cost calculation, budget enforcement with circuit breaker, alert thresholds (80%/95%/100%)
- **SmartAIVisionClient**: Intelligent provider selection, cache-first strategy, automatic fallback on failure

**Pricing (default, configurable):**
- GPT-4o: $0.002/image
- Claude 3.5 Sonnet: $0.0015/image
- Ollama (local): $0.00/image

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
- Node.js >=18.0.0 required

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
4. **Development Plan Review**: Examine to-do lists and status files in `/plan` directory to understand what's marked as complete vs. actual state

### Assessment Output

Create a status report in `/plan/status_YYYYMMDDHHMM.md` with the following format:

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

- **Minimum Coverage**: 85% code coverage ratio required for all new code
- **Test Pass Rate**: 100% - all tests must pass, no exceptions
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

## Issue Tracking with Beads

IRIS uses **Beads** (`bd`) for dependency-aware issue tracking. This system is designed specifically for AI-supervised workflows, enabling agents to systematically work through tasks with clear dependency chains.

### Why Beads?

- **Dependency Awareness**: Issues explicitly declare what blocks them and what they block
- **Ready Work Discovery**: `bd ready` shows all unblocked issues ready to claim
- **AI-Friendly**: JSON output for programmatic access, automatic git sync
- **Collaboration**: Multiple agents can work simultaneously without conflicts
- **Context Preservation**: Each issue contains full context and success criteria

### Quick Reference

**Finding Work:**
```bash
# Show all issues ready to work on (no blockers)
bd ready

# Show issues by priority
bd list --priority 0  # P0 - Critical
bd list --priority 1  # P1 - High
bd list --priority 2  # P2 - Medium
bd list --priority 3  # P3 - Low

# View issue details
bd show iris-7

# Check dependency tree
bd dep tree iris-5
```

**Claiming Work:**
```bash
# Set yourself as assignee
bd update iris-7 --assignee claude-agent

# Mark as in progress
bd update iris-7 --status in_progress
```

**During Work:**
```bash
# Create discovered work
bd create "Found issue during iris-7" --deps "discovered-from:iris-7" -p 1 -t task

# Add blocking dependency
bd dep add iris-8 iris-7  # iris-7 blocks iris-8
```

**Completing Work:**
```bash
# Close issue
bd close iris-7 --reason "Completed in commit abc123"

# Find next work
bd ready
```

### Current Issue Status

**Phase 2 Remaining Work (19 issues):**

- **Sub-Phase 2B** (iris-5): Visual Classification Integration (Week 5-7)
  - iris-6 (P1): Week 5-6 AI Classifier Implementation
  - iris-7 (P0): Week 7 Validation Harness & Golden Dataset ⚠️ **CRITICAL**

- **Sub-Phase 2C** (iris-8): Parallel Execution & Performance (Week 8-10)
  - iris-9 (P1): Week 8-9 Parallel Execution Architecture
  - iris-10 (P1): Week 10 Optimization & Profiling

- **Sub-Phase 2D** (iris-11): CLI Integration & Reporting (Week 11-14)
  - iris-12 (P1): Week 11-12 CLI Command Implementation
  - iris-13 (P1): Week 13-14 Report Generation

- **Sub-Phase 2E** (iris-14): Accessibility Foundation (Week 15-18)
  - iris-15 (P1): Week 15-16 Axe-core Integration
  - iris-16 (P1): Week 17-18 Integration & Polish

- **Infrastructure Issues** (P2):
  - iris-17: Fix concurrency control bug in visual-runner.ts
  - iris-18: AccessibilityRunner URL handling architecture
  - iris-19: Baseline creation workflow improvement

- **Optimization Tasks** (P3):
  - iris-1: Performance test timing threshold adjustment
  - iris-2: Branch coverage improvement to 80%+
  - iris-3: Accessibility E2E infrastructure decision
  - iris-4: Database test optimization

**Critical Path:** iris-6 → iris-7 → iris-8 → iris-11 → iris-14 → iris-16

**Ready Work:** 10 issues with no blockers (run `bd ready` to see list)

### Integration with Development Workflow

1. **Session Start**: Check `bd ready` to find available work
2. **Before Coding**: Read issue with `bd show iris-X` for context and success criteria
3. **During Implementation**: Create discovered issues with `discovered-from` dependency
4. **Before Commit**: Verify all acceptance criteria from issue are met
5. **After Commit**: Close issue with `bd close iris-X --reason "commit sha"`
6. **Session End**: Push changes (beads auto-syncs to git)

### Database Location

- **Database**: `.beads/iris.db` (SQLite, gitignored)
- **JSONL Sync**: `.beads/iris.jsonl` (git-tracked, auto-exported)
- **Issue Prefix**: `iris-` (e.g., iris-1, iris-2, ...)

### Documentation

For complete beads workflow documentation, see:
- **[docs/beads-migration-guide.md](docs/beads-migration-guide.md)** - Comprehensive agent guide
- **Beads GitHub**: https://github.com/steveyegge/beads
- **Quick Reference**: `bd quickstart` in terminal
