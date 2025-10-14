# Phase 2 To-Do List - REVISED

**Version:** 2.0 (Revised Plan)
**Date:** 2025-10-13
**Status:** Ready for Implementation
**Reference:** See `docs/phase2_revised_plan.md` for comprehensive details

---

## 📊 Overview

**Target Timeline:** 14-18 weeks (was: 8-12 weeks)
**Team Size:** 2 engineers
**Current Progress:** 40% Complete (Core Infrastructure + AI Vision Foundation)

**Key Changes from Original Plan:**
- ✅ Added Sub-Phase 2A: AI Vision Foundation (4 weeks)
- ✅ Added Week 7: Validation Harness & Golden Dataset
- ✅ Added Sub-Phase 2C: Parallel Execution (3 weeks)
- ✅ Descoped: Screen reader simulation → Phase 3
- ✅ Revised performance targets to realistic levels

---

## ✅ Completed (40%)

**Phase 1:** 100% Complete (122/122 tests passing)

**Phase 2 Core Infrastructure (Week 1-2):**
- ✅ Visual capture engine with stabilization
- ✅ Visual diff engine (SSIM + pixel)
- ✅ Git-integrated baseline manager
- ✅ Complete TypeScript/Zod type system
- ✅ Database schema and migrations
- ✅ 178/180 Phase 2 tests passing

**Sub-Phase 2A: AI Vision Foundation (Week 1-4):**
- ✅ Multimodal AI client architecture (text + vision)
- ✅ Vision provider integrations (OpenAI GPT-4o, Anthropic Claude 3.5, Ollama)
- ✅ Image preprocessing pipeline (resize, optimize, base64 encoding, hashing)
- ✅ AI vision result caching (LRU memory + SQLite persistence)
- ✅ Cost tracking with budget management and circuit breaker
- ✅ Smart client with automatic fallback and cost optimization
- ✅ 360/362 tests passing (added 19 new tests for Week 3-4 components)

---

## 🚧 In Progress / Not Started (60%)

### ✅ Sub-Phase 2A: AI Vision Foundation (Week 1-4) - COMPLETED

#### ✅ Week 1-2: AI Client Vision Extension - COMPLETED

+ [x] **Refactor ai-client.ts for multimodal support**
  - [x] Create `src/ai-client/base.ts` - Base client abstraction (180 lines)
  - [x] Refactor existing to `src/ai-client/text/` - Text client implementations
  - [x] Create `src/ai-client/vision/` - Vision client implementations (320 lines)
  - [x] Create `src/ai-client/factory.ts` - Client factory (145 lines)
  - [x] Update Phase 1 imports with backward compatibility layer
  - [x] Verify all 122 Phase 1 tests still pass ✅

+ [x] **Implement vision API integrations**
  - [x] OpenAI GPT-4o provider implementation (GPT-4V deprecated)
  - [x] Anthropic Claude 3.5 Sonnet vision provider
  - [x] Ollama local model support (llava, bakllava)
  - [x] Unified VisionClassification response format
  - [x] Provider-specific error handling and availability checks

+ [x] **Image preprocessing pipeline**
  - [x] Create `src/ai-client/preprocessor.ts` (260 lines)
  - [x] Implement image resizing (2048x2048 max) for API limits
  - [x] Base64 encoding for transmission
  - [x] Quality optimization (85% JPEG quality target)
  - [x] SHA-256 hash calculation for caching
  - [x] Batch processing capability

**Deliverables:**
- [x] 9 new source files (~1,100 lines total)
- [x] 24 tests with mocked providers (preprocessor batch)
- [x] Documentation: CLAUDE.md updated with architecture details

**Success Criteria:**
- ✅ All Phase 1 tests pass (122/122)
- ✅ Vision client handles mocked image analysis
- ✅ Image preprocessing reduces size by >40%
- ✅ All 3 providers have working implementations

---

#### ✅ Week 3-4: Cost Control & Caching Layer - COMPLETED

+ [x] **Result caching system**
  - [x] Create `src/ai-client/cache.ts` (348 lines)
  - [x] Implement LRU memory cache with eviction
  - [x] SQLite-backed persistent cache with TTL
  - [x] Cache key generation (provider:model:baseline_hash:current_hash)
  - [x] TTL-based invalidation (default 30 days)
  - [x] Database schema: `ai_vision_cache` table
  - [x] Cache hit/miss tracking and statistics

+ [x] **Cost tracking and budgets**
  - [x] Create `src/ai-client/cost-tracker.ts` (308 lines)
  - [x] Real-time cost calculation per provider/model
  - [x] Daily and monthly budget limits
  - [x] Warning alerts at 80% budget
  - [x] Critical alerts at 95% budget
  - [x] Circuit breaker at 100% budget with exception
  - [x] Database schema: `cost_tracking` table
  - [x] Default pricing (GPT-4o: $0.002, Claude 3.5: $0.0015, Ollama: free)

+ [x] **Smart fallback strategies**
  - [x] Create `src/ai-client/smart-client.ts` (233 lines)
  - [x] Fallback chain: cache → Ollama → OpenAI → Anthropic
  - [x] Budget enforcement with circuit breaker
  - [x] Cost optimization tracking
  - [x] Provider availability checking
  - [x] Integration with preprocessor, cache, and cost tracker

+ [x] **Database migration**
  - [x] Create `migrations/002_ai_cache_cost.sql`
  - [x] Test migration with in-memory database
  - [x] Rollback instructions in comments

**Deliverables:**
- [x] 3 new source files (889 lines total)
- [x] 19 tests for caching, cost tracking, and smart client
- [x] Documentation: README.md, CLAUDE.md, PHASE2_README.md updated

**Success Criteria:**
- ✅ Cache hit rate tracking implemented
- ✅ Budget alerts trigger at thresholds (80%, 95%, 100%)
- ✅ Cost tracking with per-operation granularity
- ✅ Smart fallback with automatic provider selection

---

### Sub-Phase 2B: Visual Classification Integration (Week 5-7) ⏳ NOT STARTED

#### Week 5-6: AI Visual Classifier Implementation

+ [ ] **Classifier core**
  - [ ] Create `src/visual/ai-classifier.ts` (~300 lines)
  - [ ] Implement `analyze()` method for single comparison
  - [ ] Implement `batchAnalyze()` for multiple comparisons
  - [ ] Build analysis prompt with context
  - [ ] Parse and normalize AI responses
  - [ ] Extract reasoning and confidence scores

+ [ ] **Integration with diff engine**
  - [ ] Update `src/visual/diff.ts` (~50 lines added)
  - [ ] Add optional AI classifier parameter
  - [ ] Implement combined severity calculation
  - [ ] Add `--skip-ai` flag support
  - [ ] Ensure backward compatibility

+ [ ] **Feedback loop to selector system**
  - [ ] Create `src/visual/selector-validator.ts` (enhanced)
  - [ ] Visual confirmation of selector targets
  - [ ] Suggestion generation for better selectors
  - [ ] Integration with Phase 1 selector scoring

**Deliverables:**
- [ ] 3 source files (~350 lines new code)
- [ ] 30+ tests with mocked AI responses
- [ ] Documentation: AI classification guide, prompt engineering

**Success Criteria:**
- ✅ Classifier works with mocked responses
- ✅ No Phase 2 regressions (178/180 still pass)
- ✅ Combined severity calculation correct
- ✅ Can disable AI via flag

---

#### Week 7: Validation Harness & Golden Dataset 🔴 CRITICAL

+ [ ] **Demo application suite**
  - [ ] Create `examples/demo-apps/react-ecommerce/` (~500 lines)
    - [ ] 5 intentional change scenarios
    - [ ] 5 bug scenarios
    - [ ] Scenario documentation
  - [ ] Create `examples/demo-apps/vue-dashboard/` (~500 lines)
    - [ ] 5 intentional + 5 bug scenarios
  - [ ] Create `examples/demo-apps/html-marketing/` (~300 lines)
    - [ ] 5 intentional + 5 bug scenarios
  - [ ] Test runner scripts for all apps

+ [ ] **Golden dataset creation**
  - [ ] Create `examples/golden-dataset/` directory
  - [ ] Capture 50 labeled screenshot pairs
    - [ ] 25 intentional changes (10 minor, 10 moderate, 5 breaking)
    - [ ] 25 bugs (5 minor, 10 moderate, 10 breaking)
  - [ ] Create `index.json` manifest with labels
  - [ ] Document expected classifications
  - [ ] Create `README.md` with dataset documentation

+ [ ] **Accuracy measurement system**
  - [ ] Create `src/validation/accuracy-validator.ts` (~200 lines)
  - [ ] Implement accuracy calculation
  - [ ] False positive/negative tracking
  - [ ] Confidence breakdown analysis
  - [ ] Category-specific accuracy
  - [ ] Generate accuracy reports

+ [ ] **E2E validation suite**
  - [ ] Create `__tests__/e2e/react-ecommerce.test.ts` (10 tests)
  - [ ] Create `__tests__/e2e/vue-dashboard.test.ts` (10 tests)
  - [ ] Create `__tests__/e2e/html-marketing.test.ts` (10 tests)
  - [ ] Create `__tests__/validation/accuracy.test.ts` (5 tests)
  - [ ] Test against real browsers (not mocked)

+ [ ] **CLI validation command**
  - [ ] Add `iris validate --dataset golden`
  - [ ] Progress reporting
  - [ ] Accuracy report generation

**Deliverables:**
- [ ] 3 demo applications (~1300 lines)
- [ ] 50-item golden dataset with labels
- [ ] Accuracy validation system (~200 lines)
- [ ] 35+ E2E tests against real apps
- [ ] Documentation: Validation methodology

**Success Criteria:** 🔴 CRITICAL FOR PHASE 2 SUCCESS
- ✅ All 3 demo apps run successfully
- ✅ Golden dataset has 50 labeled examples
- ✅ **AI classification accuracy >90%** on golden dataset
- ✅ **False positive rate <5%**
- ✅ All 30 E2E tests pass with real browsers
- ✅ E2E suite completes in <10 minutes

---

### Sub-Phase 2C: Parallel Execution & Performance (Week 8-10) ⏳ NOT STARTED

#### Week 8-9: Parallel Execution Architecture

+ [ ] **Concurrent page testing**
  - [ ] Create `src/visual/parallel-executor.ts` (~350 lines)
  - [ ] Browser pool management (4 concurrent browsers)
  - [ ] Task queue with `p-limit` concurrency control
  - [ ] Resource monitoring (memory, CPU)
  - [ ] Circuit breaking on resource limits
  - [ ] Graceful degradation on failures

+ [ ] **Smart caching and incremental testing**
  - [ ] Create `src/visual/incremental-selector.ts` (~200 lines)
  - [ ] Git diff analysis for changed files
  - [ ] File-to-page mapping heuristics
  - [ ] Dependency resolution (layout → all pages)
  - [ ] Sample unchanged pages (10% for regression)
  - [ ] Create `src/visual/result-cache.ts` (~150 lines)
  - [ ] Result caching by file hash
  - [ ] Cache invalidation strategy
  - [ ] Cache hit/miss tracking

+ [ ] **Result aggregation and progress**
  - [ ] Create `src/visual/progress-reporter.ts` (~200 lines)
  - [ ] Real-time progress bar
  - [ ] Result streaming as tests complete
  - [ ] Summary generation
  - [ ] Cache hit rate reporting
  - [ ] Performance metrics

+ [ ] **CLI integration**
  - [ ] Add `--concurrency N` flag to commands
  - [ ] Add `--incremental` flag for smart selection
  - [ ] Add `--cache-only` flag to skip cache

**Deliverables:**
- [ ] 4 new source files (~900 lines)
- [ ] 33+ tests for parallel execution
- [ ] Performance benchmarks
- [ ] Documentation: Parallel execution guide

**Success Criteria:**
- ✅ 50 pages in <3 minutes (4x parallelism)
- ✅ Resource usage <2GB total memory
- ✅ No browser crashes or hangs
- ✅ Incremental testing reduces time >80% for typical commits
- ✅ Cache hit rate >40% after first week

---

#### Week 10: Optimization & Profiling

+ [ ] **Profiling and bottleneck identification**
  - [ ] Create `src/visual/profiler.ts` (~150 lines)
  - [ ] Profile each pipeline stage
  - [ ] Identify top 3 bottlenecks
  - [ ] Measure time distribution
  - [ ] Memory profiling
  - [ ] Generate profiling reports

+ [ ] **Optimization implementation**
  - [ ] Optimize stabilization (reduce 50% overhead)
    - [ ] Smart font loading detection
    - [ ] Conditional network idle wait
    - [ ] Variable delay based on complexity
  - [ ] Batch AI calls (parallel processing)
  - [ ] Browser context reuse (eliminate launch overhead)
  - [ ] Image processing optimization

+ [ ] **Performance testing**
  - [ ] Create performance regression tests
  - [ ] Benchmark 10 pages in <30s
  - [ ] Benchmark 50 pages in <3 min
  - [ ] Memory leak detection
  - [ ] CPU usage monitoring

**Deliverables:**
- [ ] Profiling system (~150 lines)
- [ ] Optimizations in existing modules
- [ ] Performance test suite
- [ ] Documentation: Performance tuning guide

**Success Criteria:**
- ✅ 10 pages in <30s (4x parallelism)
- ✅ 50 pages in <3 minutes (4x parallelism)
- ✅ Memory usage <2GB for 50-page test
- ✅ No memory leaks
- ✅ CPU usage <80% average

---

### Sub-Phase 2D: CLI Integration & Reporting (Week 11-14) ⏳ NOT STARTED

#### Week 11-12: CLI Command Implementation

+ [ ] **`iris visual-diff` command**
  - [ ] Update `src/cli.ts` with new command
  - [ ] Implement option parsing:
    - [ ] `--pages` - Page patterns to test
    - [ ] `--baseline` - Branch for baseline
    - [ ] `--semantic` - Enable AI classification
    - [ ] `--concurrency` - Parallel browsers
    - [ ] `--browser` - Browser selection
  - [ ] Integrate with visual pipeline
  - [ ] Progress reporting
  - [ ] Exit code handling (0=pass, 5=regression)

+ [ ] **Configuration system integration**
  - [ ] Create `src/visual/config.ts`
  - [ ] Extend `IrisConfig` with visual settings
  - [ ] Config file support
  - [ ] Environment variable overrides
  - [ ] Validation and helpful errors

+ [ ] **Browser selection support**
  - [ ] Support chromium, firefox, webkit
  - [ ] Browser-specific baseline storage
  - [ ] Document cross-browser limitations
  - [ ] Rendering difference handling

+ [ ] **CLI UX improvements**
  - [ ] Colored output
  - [ ] Progress spinners
  - [ ] Summary statistics
  - [ ] Interactive baseline updates
  - [ ] Helpful error messages

**Deliverables:**
- [ ] Updated `src/cli.ts` (~100 lines added)
- [ ] `src/visual/config.ts` (~150 lines)
- [ ] CLI help documentation
- [ ] 15+ CLI integration tests

**Success Criteria:**
- ✅ `iris visual-diff` command works end-to-end
- ✅ All flags parsed correctly
- ✅ Configuration system integrated
- ✅ Browser selection functional

---

#### Week 13-14: Report Generation

+ [ ] **HTML report generator**
  - [ ] Create `src/visual/reporter.ts` (~400 lines)
  - [ ] HTML template with embedded CSS
  - [ ] Base64 image embedding (self-contained)
  - [ ] Side-by-side comparison view
  - [ ] Diff overlay visualization
  - [ ] Severity filtering and grouping
  - [ ] Navigation and search

+ [ ] **Multi-format export**
  - [ ] JSON format (machine-readable)
  - [ ] JUnit XML format (CI/CD)
  - [ ] Markdown format (human-readable)
  - [ ] Custom template support

+ [ ] **Asset management**
  - [ ] Report directory structure
  - [ ] Artifact organization
  - [ ] Relative path handling
  - [ ] Self-contained HTML option
  - [ ] External artifacts option

+ [ ] **Report CLI integration**
  - [ ] Add `--report-format` flag
  - [ ] Add `--report-output` flag
  - [ ] Automatic report generation
  - [ ] Report path display in summary

**Deliverables:**
- [ ] `src/visual/reporter.ts` (~400 lines)
- [ ] HTML template
- [ ] 10+ report generation tests
- [ ] Documentation: Report formats guide

**Success Criteria:**
- ✅ HTML reports are self-contained
- ✅ All formats export correctly
- ✅ Reports are portable
- ✅ Interactive features work

---

### Sub-Phase 2E: Accessibility Foundation (Week 15-18) ⏳ NOT STARTED

**NOTE: DESCOPED - Axe-core integration only**
- ❌ Keyboard navigation testing → Phase 3
- ❌ Screen reader simulation → Phase 3 or separate project
- ❌ Focus trap detection → Phase 3

#### Week 15-16: Axe-core Integration

+ [ ] **Axe-core Playwright integration**
  - [ ] Create `src/a11y/axe-runner.ts` (~150 lines)
  - [ ] Use `@axe-core/playwright` package
  - [ ] Run on pages during visual testing
  - [ ] Store results in database
  - [ ] Result parsing and normalization

+ [ ] **Rule configuration**
  - [ ] Create `src/a11y/config.ts`
  - [ ] WCAG 2.1 AA default rules
  - [ ] Custom rule configuration
  - [ ] Severity-based filtering
  - [ ] False positive suppression

+ [ ] **Database schema**
  - [ ] Extend database with a11y tables
  - [ ] `accessibility_issues` table
  - [ ] Issue tracking and history
  - [ ] Migration script

+ [ ] **CLI integration**
  - [ ] Add `iris a11y` command
  - [ ] Add `--fail-on` severity flag
  - [ ] Integrate with visual-diff workflow
  - [ ] Accessibility reporting

**Deliverables:**
- [ ] 2 source files (~200 lines)
- [ ] Database schema extension
- [ ] 10+ tests
- [ ] Documentation: Accessibility testing guide

**Success Criteria:**
- ✅ Axe-core runs successfully
- ✅ Results stored in database
- ✅ CLI command works
- ✅ Reports include a11y issues

---

#### Week 17-18: Integration & Polish

+ [ ] **Unified workflow**
  - [ ] Combine visual + accessibility in single command
  - [ ] Shared configuration
  - [ ] Integrated reporting (visual + a11y)
  - [ ] Single exit code for both

+ [ ] **Documentation completion**
  - [ ] Getting started guide
  - [ ] API documentation
  - [ ] Troubleshooting guide
  - [ ] Cost estimation calculator
  - [ ] Configuration reference
  - [ ] Best practices guide

+ [ ] **Example projects**
  - [ ] React app with visual regression
  - [ ] Vue app with accessibility
  - [ ] GitHub Actions integration example
  - [ ] GitLab CI integration example

+ [ ] **Final testing**
  - [ ] Full regression test suite
  - [ ] Performance validation
  - [ ] Cost validation
  - [ ] Accuracy validation
  - [ ] Documentation accuracy

+ [ ] **Migration preparation**
  - [ ] Migration guide from Phase 1
  - [ ] Breaking changes documentation
  - [ ] Upgrade checklist
  - [ ] Rollback procedures

**Deliverables:**
- [ ] Complete documentation suite
- [ ] 3+ example projects
- [ ] Migration guide
- [ ] Video walkthrough (optional)

**Success Criteria:**
- ✅ All Phase 2 tests pass (target: >95%)
- ✅ Documentation is complete and accurate
- ✅ Example projects work end-to-end
- ✅ Ready for production use

---

## 📈 Progress Tracking

### Week 1-4: AI Vision Foundation
- [ ] Week 1-2: AI Client Extension (0% complete)
- [ ] Week 3-4: Cost Control & Caching (0% complete)

### Week 5-7: Visual Classification
- [ ] Week 5-6: Classifier Implementation (0% complete)
- [ ] Week 7: Validation Harness (0% complete) 🔴 CRITICAL

### Week 8-10: Parallel Execution
- [ ] Week 8-9: Parallel Architecture (0% complete)
- [ ] Week 10: Optimization (0% complete)

### Week 11-14: CLI & Reporting
- [ ] Week 11-12: CLI Commands (0% complete)
- [ ] Week 13-14: Report Generation (0% complete)

### Week 15-18: Accessibility & Polish
- [ ] Week 15-16: Axe-core Integration (0% complete)
- [ ] Week 17-18: Integration & Polish (0% complete)

**Overall Phase 2 Progress: 25% Complete (Core Infrastructure Only)**

---

## 🎯 Success Metrics (Revised)

### Technical Criteria
- [ ] All CLI commands work successfully
- [ ] **AI classification accuracy >90%** on golden dataset
- [ ] **False positive rate <5%**
- [ ] **50 pages in <3 minutes** (4x parallelism)
- [ ] Test coverage >85% for visual modules
- [ ] Zero Phase 1 regressions (122/122 pass)

### User Experience Criteria
- [ ] Setup time <10 minutes
- [ ] Cost estimation accurate within 10%
- [ ] Cache hit rate >50%
- [ ] CI pipeline overhead <3 minutes
- [ ] Actionable guidance >80%

### Integration Criteria
- [ ] Backward compatible with Phase 1
- [ ] Database migration works
- [ ] Phase 1 tests still pass
- [ ] Example projects demonstrate value

### Documentation Criteria
- [ ] Complete API documentation
- [ ] User guides for workflows
- [ ] Troubleshooting guides
- [ ] Example projects
- [ ] Migration guide

---

## ⚠️ Risk Management

### High-Risk Items

**1. AI Classification Accuracy (Week 5-7)** 🔴
- **Risk**: Accuracy <90%
- **Mitigation**: Large golden dataset, prompt engineering, multiple providers

**2. Performance Targets (Week 8-10)** 🟡
- **Risk**: Can't achieve <3min for 50 pages
- **Mitigation**: Parallel execution, incremental testing, smart caching

**3. Cost Control (Week 3-4)** 🟡
- **Risk**: Cache misses cause high costs
- **Mitigation**: Aggressive caching, fallbacks, budgets, local models

---

## 📋 Next Steps

**Immediate (This Week):**
1. [ ] Review and approve this revised plan
2. [ ] Update stakeholder expectations (14-18 weeks)
3. [ ] Begin Sub-Phase 2A: AI Client Refactoring

**Week 1 Tasks:**
1. [ ] Create `src/ai-client/base.ts`
2. [ ] Refactor existing ai-client to text-only
3. [ ] Create `src/ai-client/vision.ts`
4. [ ] Set up vision API testing environment

**Critical Path:**
- Week 1-4: AI Vision Foundation (blocks everything)
- Week 7: Validation (proves it works)
- Week 8-10: Parallel Execution (makes it fast enough)

---

**Document Status**: ✅ Ready for Implementation
**Dependencies**: None - can start Week 1 immediately
**Estimated Completion**: 14-18 weeks from start date
