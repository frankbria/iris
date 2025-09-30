# IRIS Project Index

**Quick navigation guide for the IRIS codebase**
**Last Updated:** September 30, 2025

---

## 🚀 Start Here

**New to IRIS?** Read in this order:
1. [README.md](README.md) - Project overview and quick start
2. [READY_FOR_COMMIT.md](READY_FOR_COMMIT.md) - Current status and commit guide
3. [DEVELOPMENT_INSTRUCTIONS.md](DEVELOPMENT_INSTRUCTIONS.md) - Development guide

**Want to contribute?**
1. [DEVELOPMENT_INSTRUCTIONS.md](DEVELOPMENT_INSTRUCTIONS.md) - How to develop
2. [plan/phase2_todo.md](plan/phase2_todo.md) - What needs to be done
3. [GIT_COMMIT_GUIDE.md](GIT_COMMIT_GUIDE.md) - How to commit

**AI Agent?**
1. [AGENT_INSTRUCTIONS.md](AGENT_INSTRUCTIONS.md) - Step-by-step development
2. [CLAUDE.md](CLAUDE.md) - Claude Code specific instructions
3. [docs/phase2_technical_architecture.md](docs/phase2_technical_architecture.md) - Architecture

---

## 📁 File Organization

### Root Directory

**Core Documentation:**
- `README.md` - Project overview, quick start, features
- `DEVELOPMENT_INSTRUCTIONS.md` - Comprehensive development guide (primary reference)
- `CODEBASE_ANALYSIS_SUMMARY.md` - Complete codebase analysis and status
- `PROJECT_INDEX.md` - This file (navigation guide)

**Git & Commit:**
- `READY_FOR_COMMIT.md` - Commit preparation guide
- `GIT_COMMIT_GUIDE.md` - Git workflow instructions
- `COMMIT_MESSAGE.txt` - Prepared commit message
- `PRE_COMMIT_CHECKLIST.sh` - Automated verification script

**Phase 2 Documentation:**
- `PHASE2_SETUP_SUMMARY.md` - Phase 2 setup overview

**AI Agent Instructions:**
- `AGENT_INSTRUCTIONS.md` - Development guidance for AI agents
- `CLAUDE.md` - Claude Code specific instructions

**Configuration:**
- `package.json` - Project dependencies and scripts
- `tsconfig.json` - TypeScript configuration
- `jest.config.ts` - Jest testing configuration
- `.gitignore` - Git ignore rules

### `/src` - Source Code

**Phase 1 Core (9 modules - Complete):**
- `cli.ts` (198 lines) - CLI entry point with Commander.js
- `executor.ts` (243 lines) - Action execution engine
- `browser.ts` (61 lines) - Playwright wrapper
- `translator.ts` (174 lines) - NL to action translation
- `protocol.ts` (297 lines) - JSON-RPC WebSocket server
- `ai-client.ts` (5,734+ lines) - Multi-provider AI integration
- `config.ts` (3,423+ lines) - Configuration management
- `db.ts` (1,838+ lines) - SQLite persistence
- `watcher.ts` (13,907+ lines) - File watching system

**Phase 2 Visual (40% Complete):**
- `visual/index.ts` - Public API exports
- `visual/types.ts` - TypeScript/Zod schemas
- `visual/capture.ts` (200 lines) - Screenshot capture engine
- `visual/diff.ts` (310 lines) - Visual diff engine
- `visual/baseline.ts` (299 lines) - Git-integrated baseline manager

**Phase 2 Accessibility (Types Only):**
- `a11y/index.ts` - Public API exports
- `a11y/types.ts` - Accessibility type definitions

**Phase 2 Utilities:**
- `utils/index.ts` - Public API exports
- `utils/types.ts` - Shared utility types
- `utils/migration.ts` - Database migration system

### `/docs` - Documentation

**Product & Planning:**
- `prd.md` (10,212 bytes) - Product requirements document
- `dev_plan.md` (24,659 bytes) - Development plan and phases
- `tech_specs.md` (6,027 bytes) - Technical specifications
- `user_stories.md` (13,521 bytes) - User stories and scenarios

**Architecture:**
- `phase2_technical_architecture.md` (86,015 bytes / 2,556 lines) - **PRIMARY REFERENCE**
  - Complete Phase 2 architecture
  - Implementation guides
  - Type definitions
  - Database schemas
  - Testing strategies

### `/plan` - Planning & Tracking

**Active Planning:**
- `phase1_todo.md` (10,418 bytes) - Phase 1 tasks (COMPLETE)
- `phase2_todo.md` (18,669 bytes) - Phase 2 tasks (IN PROGRESS)

**Archived:**
- Old status reports removed (superseded by CODEBASE_ANALYSIS_SUMMARY.md)
- Old phase1.md removed (superseded by phase1_todo.md)

### `/__tests__` - Test Suites

**Phase 1 Tests (10 suites - 122 tests):**
- `cli.test.ts` - CLI command testing
- `executor.test.ts` - Action execution
- `browser.test.ts` - Browser automation
- `translator.test.ts` - Translation
- `protocol.test.ts` - JSON-RPC server
- `ai-client.test.ts` - AI integration
- `config.test.ts` - Configuration
- `db.test.ts` - Database
- `watcher.test.ts` - File watching
- `integration.test.ts` - End-to-end

**Phase 2 Tests (7 suites - 99 tests):**
- `visual/types.test.ts` - Visual type validation (41 tests)
- `visual/capture.test.ts` - Capture engine (22 tests)
- `visual/diff.test.ts` - Diff engine (17 tests)
- `visual/baseline.test.ts` - Baseline manager (18 tests)
- `a11y/types.test.ts` - Accessibility types (1 test, 1 skipped)
- `utils/types.test.ts` - Utility types
- `utils/migration.test.ts` - Migration system (1 test, 1 skipped)

---

## 🎯 Quick Reference by Task

### I want to understand the project

**Read first:**
1. `README.md` - Overview and features
2. `CODEBASE_ANALYSIS_SUMMARY.md` - Current status

**Then explore:**
- `docs/prd.md` - Product vision
- `docs/dev_plan.md` - Development roadmap
- `docs/phase2_technical_architecture.md` - Architecture details

### I want to start developing

**Setup:**
1. Read `DEVELOPMENT_INSTRUCTIONS.md` - Complete guide
2. Check `plan/phase2_todo.md` - What needs work
3. Review `docs/phase2_technical_architecture.md` - Architecture

**Start coding:**
1. Pick a task from `plan/phase2_todo.md`
2. Follow TDD approach (write tests first)
3. Reference architecture in `docs/phase2_technical_architecture.md`

### I want to commit code

**Before committing:**
1. Read `READY_FOR_COMMIT.md` - Quick guide
2. Run `./PRE_COMMIT_CHECKLIST.sh` - Automated checks
3. Review `GIT_COMMIT_GUIDE.md` - Detailed instructions

**Commit:**
1. Stage files: `git add src/ __tests__/ docs/ *.md`
2. Commit: `git commit -F COMMIT_MESSAGE.txt`
3. Push: `git push origin main`

### I want to understand Phase 2 architecture

**Primary reference:**
- `docs/phase2_technical_architecture.md` (2,556 lines)
  - Sections 1-2: Type system and interfaces
  - Sections 3-4: Database schema
  - Sections 5-6: CLI and testing
  - Sections 7-8: Performance and success metrics

**Implementation status:**
- `CODEBASE_ANALYSIS_SUMMARY.md` - What's complete
- `plan/phase2_todo.md` - What's remaining

### I'm an AI coding assistant

**Start here:**
1. `AGENT_INSTRUCTIONS.md` - Development workflow
2. `CLAUDE.md` - Claude Code specific
3. `DEVELOPMENT_INSTRUCTIONS.md` - Reference guide

**For implementation:**
1. Check `plan/phase2_todo.md` - Tasks
2. Read `docs/phase2_technical_architecture.md` - Architecture
3. Follow TDD approach in tests first

---

## 📊 Project Status Summary

### Current State (September 30, 2025)

**Overall Progress:** 70% Complete
- Phase 1: ✅ 100% (Production-ready)
- Phase 2: 🟡 40% (Core infrastructure)

**Test Status:** 221/223 passing (99.1%)
- Phase 1: 122/122 (100%)
- Phase 2: 99/101 (98% - 2 skipped)

**Lines of Code:**
- Phase 1: 25,667+ lines (9 modules)
- Phase 2: ~1,600 lines (visual core)
- Tests: ~4,600 lines (17 suites)

### What's Complete

**Phase 1 (All Features):**
- CLI framework with 3 commands
- Browser automation via Playwright
- AI translation (OpenAI/Anthropic/Ollama)
- File watching with auto-execution
- JSON-RPC protocol server
- SQLite persistence

**Phase 2 (Core Infrastructure):**
- Visual capture engine
- Visual diff engine (SSIM + pixel)
- Git-integrated baseline manager
- Complete TypeScript/Zod type system
- Database migration framework
- Accessibility type definitions

### What's Remaining (Phase 2)

**High Priority (~60% to complete):**
- AI visual classification integration
- CLI commands: `iris visual-diff`, `iris a11y`
- HTML/JUnit report generation
- Visual test orchestration runner
- Accessibility testing implementation

**Implementation Time Estimate:**
- AI Classification: 2-3 days
- CLI Integration: 2-3 days
- Report Generation: 2-3 days
- Accessibility: 3-4 days
- **Total: 2-3 weeks to Phase 2 completion**

---

## 🔍 Finding Specific Information

### Architecture & Design

**Question:** How does visual regression work?
**Answer:** `docs/phase2_technical_architecture.md` sections 1-2 (type system), section 7 (implementation)

**Question:** What's the database schema?
**Answer:** `docs/phase2_technical_architecture.md` section 5 (migration), `src/utils/migration.ts`

**Question:** How do I add a new CLI command?
**Answer:** `docs/phase2_technical_architecture.md` section 6, `src/cli.ts`

### Implementation Details

**Question:** How to implement AI visual classification?
**Answer:** `docs/phase2_technical_architecture.md:2086-2293`, `DEVELOPMENT_INSTRUCTIONS.md` (Next Steps)

**Question:** What tests should I write?
**Answer:** `docs/phase2_technical_architecture.md` section 4 (TDD strategy), existing tests in `__tests__/`

**Question:** How to add Phase 2 dependencies?
**Answer:** `docs/phase2_technical_architecture.md` section 3, `package.json`

### Status & Planning

**Question:** What's the current status?
**Answer:** `CODEBASE_ANALYSIS_SUMMARY.md`, `READY_FOR_COMMIT.md`

**Question:** What needs to be done?
**Answer:** `plan/phase2_todo.md`, `DEVELOPMENT_INSTRUCTIONS.md` (Remaining Work)

**Question:** When is Phase 2 complete?
**Answer:** Estimated 2-3 weeks based on remaining tasks in `plan/phase2_todo.md`

---

## 🛠️ Common Tasks

### Run Tests
```bash
npm test
# Expected: 221 passing, 2 skipped
```

### Build Project
```bash
npm run build
```

### Start Development
```bash
# Run CLI command
npm start run "click #button"

# Watch files
npm start watch src/

# Start protocol server
npm start connect
```

### Pre-Commit Checks
```bash
./PRE_COMMIT_CHECKLIST.sh
```

### View Coverage
```bash
npm test -- --coverage
open coverage/lcov-report/index.html
```

---

## 📚 Documentation Hierarchy

**Level 1 - Overview (Start Here):**
1. `README.md` - What is IRIS?
2. `READY_FOR_COMMIT.md` - Current status
3. `PROJECT_INDEX.md` - This file

**Level 2 - Development:**
1. `DEVELOPMENT_INSTRUCTIONS.md` - How to develop
2. `GIT_COMMIT_GUIDE.md` - How to commit
3. `CODEBASE_ANALYSIS_SUMMARY.md` - What exists

**Level 3 - Architecture:**
1. `docs/phase2_technical_architecture.md` - Complete design
2. `docs/prd.md` - Product vision
3. `docs/dev_plan.md` - Roadmap

**Level 4 - Planning:**
1. `plan/phase2_todo.md` - Tasks
2. `docs/user_stories.md` - Use cases
3. `docs/tech_specs.md` - Technical details

**Level 5 - AI Agents:**
1. `AGENT_INSTRUCTIONS.md` - Development workflow
2. `CLAUDE.md` - Claude Code specific

---

## 🎓 Learning Path

**Beginner (Understanding IRIS):**
1. Read `README.md`
2. Try running commands: `npm start run "click #button"`
3. Read `docs/prd.md` for vision

**Intermediate (Contributing):**
1. Read `DEVELOPMENT_INSTRUCTIONS.md`
2. Explore `src/` directory
3. Run tests: `npm test`
4. Review `plan/phase2_todo.md`

**Advanced (Architecture):**
1. Study `docs/phase2_technical_architecture.md`
2. Review implementation in `src/visual/`
3. Understand test patterns in `__tests__/`
4. Design new features

**Expert (Leading Development):**
1. Master entire codebase
2. Update planning docs
3. Define new phases
4. Mentor contributors

---

## 🔗 External Resources

**GitHub:**
- Repository: https://github.com/frankbria/iris
- Issues: https://github.com/frankbria/iris/issues

**Social:**
- Twitter: https://twitter.com/FrankBria18044

**Dependencies:**
- Playwright: https://playwright.dev
- Zod: https://zod.dev
- Sharp: https://sharp.pixelplumbing.com

---

**Last Updated:** September 30, 2025
**Status:** Phase 1 Complete, Phase 2 40% Complete
**Tests:** 221/223 passing (99.1%)
