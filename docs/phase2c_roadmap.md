# Phase 2C Implementation Roadmap

**Phase:** Sub-Phase 2C - Parallel Execution & Performance (Week 8-10)
**Status:** 📋 **PLANNED** (Ready to implement)
**Prerequisites:** ✅ Phase 2A Complete, ✅ Phase 2B Complete

---

## Overview

Phase 2C adds parallel execution capabilities and performance optimizations to the visual regression testing system, targeting 50 pages tested in <3 minutes with <2GB memory usage.

### Goals

1. **Concurrent Testing:** 4x browser parallelism with resource management
2. **Smart Caching:** Incremental test selection based on git changes
3. **Performance:** 10 pages in <30s, 50 pages in <3 minutes
4. **Efficiency:** >80% time reduction for typical commits via incremental testing

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Visual Test Runner                        │
└───────────────────┬─────────────────────────────────────────┘
                    │
                    ├─> IncrementalSelector (git diff analysis)
                    │   └─> Smart test selection
                    │
                    ├─> ParallelExecutor (4x browsers)
                    │   ├─> Browser pool management
                    │   ├─> Task queue (p-limit)
                    │   ├─> Resource monitoring (memory, CPU)
                    │   └─> Circuit breaking
                    │
                    ├─> ResultCache (file hash-based)
                    │   ├─> Cache invalidation
                    │   └─> Hit/miss tracking
                    │
                    └─> ProgressReporter (real-time)
                        ├─> Progress bar
                        ├─> Result streaming
                        └─> Performance metrics
```

---

## Implementation Plan

### Week 8-9: Parallel Execution Architecture

#### 1. Concurrent Page Testing

**File:** `src/visual/parallel-executor.ts` (~350 lines)

**Responsibilities:**
- Browser pool management (4 concurrent browsers)
- Task queue with p-limit concurrency control
- Resource monitoring (memory, CPU)
- Circuit breaking on resource limits
- Graceful degradation on failures

**Interface:**
```typescript
export interface ParallelExecutorConfig {
  concurrency: number; // Default: 4
  maxMemoryMB: number; // Default: 2048
  maxCPUPercent: number; // Default: 80
  circuitBreakerThreshold: number; // Default: 3 failures
}

export interface BrowserPoolStats {
  active: number;
  idle: number;
  total: number;
  memoryUsageMB: number;
  cpuUsagePercent: number;
}

export class ParallelExecutor {
  constructor(config: ParallelExecutorConfig);

  async execute<T>(
    tasks: Array<() => Promise<T>>,
    options?: { failFast?: boolean }
  ): Promise<T[]>;

  async getBrowserPoolStats(): Promise<BrowserPoolStats>;
  async shutdown(): Promise<void>;
}
```

**Key Features:**
- Playwright browser context reuse (eliminate launch overhead)
- Dynamic concurrency based on resource usage
- Automatic browser cleanup on failure
- Progress callbacks for real-time updates

**Tests:** 12 tests
- Browser pool initialization
- Concurrent task execution
- Resource limit enforcement
- Circuit breaker activation
- Graceful shutdown
- Error handling

---

#### 2. Smart Caching and Incremental Testing

**File:** `src/visual/incremental-selector.ts` (~200 lines)

**Responsibilities:**
- Git diff analysis for changed files
- File-to-page mapping heuristics
- Dependency resolution (layout → all pages)
- Sample unchanged pages (10% for regression)

**Interface:**
```typescript
export interface IncrementalSelectorConfig {
  gitDiffBase?: string; // Default: 'HEAD'
  sampleRate: number; // Default: 0.1 (10%)
  dependencyMap?: Map<string, string[]>; // File → Pages
}

export interface TestSelection {
  selected: string[]; // Pages to test
  skipped: string[]; // Pages to skip
  reason: Map<string, string>; // Page → Reason
  cacheHitEstimate: number; // Expected cache hit rate
}

export class IncrementalSelector {
  constructor(config: IncrementalSelectorConfig);

  async selectTests(allTests: string[]): Promise<TestSelection>;
  async analyzeGitDiff(): Promise<string[]>; // Changed files
  mapFilesToPages(files: string[]): string[]; // File → Page mapping
}
```

**Key Features:**
- Git integration for change detection
- Configurable dependency mapping
- Smart sampling of unchanged pages
- Whitelist/blacklist support

**Tests:** 10 tests
- Git diff analysis
- File-to-page mapping
- Dependency resolution
- Sampling strategy
- Edge cases (no changes, all changes)

---

**File:** `src/visual/result-cache.ts` (~150 lines)

**Responsibilities:**
- Result caching by file hash
- Cache invalidation strategy
- Cache hit/miss tracking

**Interface:**
```typescript
export interface ResultCacheConfig {
  cacheDir: string; // Default: '.iris-cache'
  ttlDays: number; // Default: 7
  maxSizeMB: number; // Default: 1024
}

export interface CacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  sizeMB: number;
  entries: number;
}

export class ResultCache {
  constructor(config: ResultCacheConfig);

  async get(key: string): Promise<DiffResult | null>;
  async set(key: string, result: DiffResult): Promise<void>;
  async invalidate(keys: string[]): Promise<void>;
  async getStats(): Promise<CacheStats>;
  async cleanup(): Promise<void>; // Remove expired entries
}
```

**Key Features:**
- SHA-256 hash-based keys (baseline hash + current hash)
- File-based cache storage (JSON)
- TTL-based expiration
- Size limit enforcement

**Tests:** 8 tests
- Cache hit/miss
- TTL expiration
- Size limit enforcement
- Invalidation
- Statistics tracking

---

#### 3. Result Aggregation and Progress

**File:** `src/visual/progress-reporter.ts` (~200 lines)

**Responsibilities:**
- Real-time progress bar
- Result streaming as tests complete
- Summary generation
- Cache hit rate reporting
- Performance metrics

**Interface:**
```typescript
export interface ProgressReporterConfig {
  mode: 'ci' | 'interactive'; // CI: no progress bar
  updateInterval: number; // Default: 100ms
}

export interface ProgressUpdate {
  completed: number;
  total: number;
  current: string; // Current test name
  passed: number;
  failed: number;
  cacheHits: number;
  elapsedMs: number;
  estimatedRemainingMs: number;
}

export class ProgressReporter {
  constructor(config: ProgressReporterConfig);

  start(total: number): void;
  update(result: DiffResult): void;
  finish(): ProgressSummary;

  // Event emitter
  on(event: 'update', handler: (update: ProgressUpdate) => void): void;
  on(event: 'complete', handler: (summary: ProgressSummary) => void): void;
}
```

**Key Features:**
- CLI progress bar (using cli-progress or ora)
- Real-time ETA calculation
- Color-coded output (green/red/yellow)
- CI-friendly mode (no ANSI codes)

**Tests:** 6 tests
- Progress tracking
- ETA calculation
- Event emission
- CI mode behavior
- Summary generation

---

#### 4. CLI Integration

**Files:** `src/cli.ts` (modifications)

**New Flags:**
- `--concurrency N` - Number of parallel browsers (default: 4)
- `--incremental` - Smart test selection based on git changes
- `--cache-dir PATH` - Result cache directory (default: .iris-cache)
- `--no-cache` - Disable result caching

**Example Usage:**
```bash
# Run with 8 parallel browsers
iris visual-diff --concurrency 8

# Incremental testing (only changed pages)
iris visual-diff --incremental

# Disable caching
iris visual-diff --no-cache

# Full parallelization + incremental + caching
iris visual-diff --concurrency 4 --incremental
```

**Tests:** 4 tests
- Flag parsing
- Default values
- Invalid inputs
- CLI help text

---

### Week 10: Optimization & Profiling

#### 1. Profiling and Bottleneck Identification

**File:** `src/visual/profiler.ts` (~150 lines)

**Responsibilities:**
- Profile each pipeline stage
- Identify top 3 bottlenecks
- Measure time distribution
- Memory profiling
- Generate profiling reports

**Interface:**
```typescript
export interface ProfilingReport {
  stages: Map<string, number>; // Stage → Duration (ms)
  bottlenecks: Array<{ stage: string; durationMs: number; percentage: number }>;
  memoryPeakMB: number;
  totalDurationMs: number;
}

export class Profiler {
  start(stageName: string): void;
  end(stageName: string): void;

  async getReport(): Promise<ProfilingReport>;
  async exportReport(path: string): Promise<void>; // JSON export
}
```

**Usage:**
```typescript
const profiler = new Profiler();

profiler.start('capture');
await captureEngine.capture(...);
profiler.end('capture');

profiler.start('diff');
await diffEngine.compare(...);
profiler.end('diff');

const report = await profiler.getReport();
console.log('Bottlenecks:', report.bottlenecks);
```

**Tests:** 5 tests
- Stage timing
- Bottleneck identification
- Memory tracking
- Report generation
- Export functionality

---

#### 2. Optimization Implementation

**Target Areas:**

1. **Capture Stabilization** (reduce 50% overhead)
   - Smart font loading detection (only when custom fonts present)
   - Conditional network idle wait (skip for static pages)
   - Variable delay based on page complexity

2. **Batch AI Calls** (parallel processing)
   - Group multiple AI classifications
   - Use batchAnalyze() from Phase 2B
   - Leverage shared cache

3. **Browser Context Reuse** (eliminate launch overhead)
   - Reuse browser contexts across tests
   - Only restart on failure/crash
   - Shared browser pool

4. **Image Processing Optimization**
   - Parallel image preprocessing
   - Lazy loading of baseline images
   - Image diff early-exit (from Phase 2A)

**Files Modified:**
- `src/visual/capture.ts` - Stabilization optimizations
- `src/visual/visual-runner.ts` - Batch AI call integration
- `src/visual/parallel-executor.ts` - Browser reuse

**Tests:** 8 tests
- Optimized stabilization behavior
- Batch AI processing
- Browser context reuse
- Performance regression detection

---

#### 3. Performance Testing

**File:** `__tests__/performance/parallel-execution.test.ts`

**Benchmark Tests:**
```typescript
describe('Parallel Execution Performance', () => {
  it('should complete 10 pages in <30s with 4x parallelism', async () => {
    const start = Date.now();
    await runner.runTests(tenPages, { concurrency: 4 });
    const duration = Date.now() - start;
    expect(duration).toBeLessThan(30000);
  });

  it('should complete 50 pages in <3 minutes with 4x parallelism', async () => {
    const start = Date.now();
    await runner.runTests(fiftyPages, { concurrency: 4 });
    const duration = Date.now() - start;
    expect(duration).toBeLessThan(180000);
  });

  it('should use <2GB memory for 50-page test', async () => {
    const before = process.memoryUsage().heapUsed;
    await runner.runTests(fiftyPages, { concurrency: 4 });
    const after = process.memoryUsage().heapUsed;
    const usedMB = (after - before) / (1024 * 1024);
    expect(usedMB).toBeLessThan(2048);
  });

  it('should not leak memory across runs', async () => {
    // Run tests 3 times, check memory stable
    const runs = [];
    for (let i = 0; i < 3; i++) {
      await runner.runTests(tenPages);
      runs.push(process.memoryUsage().heapUsed);
    }
    // Memory should not grow >10% across runs
    const growth = (runs[2] - runs[0]) / runs[0];
    expect(growth).toBeLessThan(0.1);
  });
});
```

**Tests:** 6 performance benchmarks
- 10 pages in <30s
- 50 pages in <3 min
- Memory <2GB
- No memory leaks
- CPU <80% average
- Cache hit rate >40%

---

## Deliverables

### Source Files
- [x] `src/visual/parallel-executor.ts` (~350 lines)
- [x] `src/visual/incremental-selector.ts` (~200 lines)
- [x] `src/visual/result-cache.ts` (~150 lines)
- [x] `src/visual/progress-reporter.ts` (~200 lines)
- [x] `src/visual/profiler.ts` (~150 lines)

**Total:** ~1,050 lines of new code

### Tests
- [x] Parallel execution tests (12 tests)
- [x] Incremental selection tests (10 tests)
- [x] Result cache tests (8 tests)
- [x] Progress reporter tests (6 tests)
- [x] Profiler tests (5 tests)
- [x] CLI integration tests (4 tests)
- [x] Optimization tests (8 tests)
- [x] Performance benchmarks (6 tests)

**Total:** 59 new tests

### Documentation
- [x] Parallel execution guide
- [x] Performance tuning guide
- [x] CLI usage examples
- [x] Profiling report examples

---

## Success Criteria

### Performance Targets

| Metric | Target | Current | Status |
|--------|--------|---------|--------|
| **10 pages** | <30s (4x) | TBD | ⏳ |
| **50 pages** | <3 min (4x) | TBD | ⏳ |
| **Memory usage** | <2GB | TBD | ⏳ |
| **Memory leaks** | None | TBD | ⏳ |
| **CPU usage** | <80% avg | TBD | ⏳ |
| **Cache hit rate** | >40% (week 1) | TBD | ⏳ |
| **Incremental time reduction** | >80% | TBD | ⏳ |

### Quality Targets

- ✅ >85% code coverage
- ✅ 100% test pass rate
- ✅ Zero breaking changes
- ✅ TypeScript compilation succeeds
- ✅ All benchmarks pass

---

## Implementation Strategy

### Week 8: Core Infrastructure

**Days 1-2:** ParallelExecutor
- Browser pool management
- Task queue setup
- Resource monitoring

**Days 3-4:** IncrementalSelector + ResultCache
- Git diff analysis
- File-to-page mapping
- Cache implementation

**Day 5:** ProgressReporter + CLI integration
- Progress tracking
- CLI flags

### Week 9: Testing & Integration

**Days 1-2:** Unit tests for all components
- 45 unit tests
- Mock browser contexts
- Verify edge cases

**Days 3-4:** Integration testing
- End-to-end parallel execution
- Real browser testing
- Cache behavior validation

**Day 5:** Documentation + examples
- User guides
- Code examples
- CLI documentation

### Week 10: Optimization & Profiling

**Days 1-2:** Profiling system + bottleneck identification
- Implement profiler
- Run baseline benchmarks
- Identify top 3 bottlenecks

**Days 3-4:** Optimization implementation
- Stabilization improvements
- Batch AI processing
- Browser reuse

**Day 5:** Performance testing + validation
- Run all benchmarks
- Memory leak detection
- Final validation

---

## Dependencies

### External Libraries

```json
{
  "p-limit": "^5.0.0",        // Concurrency control (already installed)
  "cli-progress": "^3.12.0",   // Progress bars
  "simple-git": "^3.25.0"      // Git operations
}
```

### Internal Dependencies

- ✅ Phase 2A: SmartAIVisionClient, ImagePreprocessor, AIVisionCache, CostTracker
- ✅ Phase 2B: Refactored AIVisualClassifier
- ✅ Existing: VisualDiffEngine, VisualCaptureEngine, BaselineManager

---

## Risk Assessment

### High Risk

**Browser Instability**
- **Risk:** Browsers crash under heavy parallel load
- **Mitigation:** Circuit breaker, automatic restart, resource limits

**Memory Leaks**
- **Risk:** Memory grows unbounded with parallel execution
- **Mitigation:** Explicit cleanup, browser context disposal, leak detection tests

### Medium Risk

**Git Integration Complexity**
- **Risk:** File-to-page mapping may be inaccurate
- **Mitigation:** Conservative defaults, manual override support, sampling

**Performance Targets Unrealistic**
- **Risk:** Cannot achieve <3 min for 50 pages
- **Mitigation:** Profiling-driven optimization, adjust targets if needed

### Low Risk

**Cache Invalidation**
- **Risk:** Stale cache results in false passes
- **Mitigation:** SHA-256 hashing, TTL expiration, manual invalidation

---

## Testing Strategy

### Unit Tests (45 tests)
- Mock browser contexts
- Isolated component testing
- Edge case coverage

### Integration Tests (8 tests)
- Real browser execution
- End-to-end workflows
- Cache behavior

### Performance Tests (6 benchmarks)
- Time limits enforced
- Memory limits enforced
- Leak detection

### Quality Gates
- ✅ All tests pass
- ✅ >85% coverage
- ✅ All benchmarks pass
- ✅ No memory leaks
- ✅ TypeScript compiles

---

## Next Steps After Phase 2C

**Phase 2D:** CLI Integration & Reporting (Week 11-14)
- Enhanced CLI commands
- Multi-format reporting (HTML/JSON/Markdown/JUnit)
- CI/CD integration examples

**Phase 2E:** Accessibility Foundation (Week 15-18)
- Axe-core integration
- WCAG 2.1 compliance
- Keyboard testing

---

## Appendix: Example Usage

### Basic Parallel Execution

```typescript
import { ParallelExecutor } from './visual/parallel-executor';

const executor = new ParallelExecutor({ concurrency: 4 });

const tasks = pages.map(page => async () => {
  return await runVisualTest(page);
});

const results = await executor.execute(tasks);
console.log(`Completed ${results.length} tests`);
```

### Incremental Testing

```typescript
import { IncrementalSelector } from './visual/incremental-selector';

const selector = new IncrementalSelector({
  sampleRate: 0.1,
  dependencyMap: new Map([
    ['src/styles/layout.css', ['*']], // Layout affects all pages
  ]),
});

const selection = await selector.selectTests(allPages);
console.log(`Running ${selection.selected.length}/${allPages.length} tests`);
console.log(`Skipping ${selection.skipped.length} (cache hit estimate: ${selection.cacheHitEstimate}%)`);
```

### Progress Reporting

```typescript
import { ProgressReporter } from './visual/progress-reporter';

const reporter = new ProgressReporter({ mode: 'interactive' });

reporter.on('update', (update) => {
  console.log(`Progress: ${update.completed}/${update.total} (${update.passed} passed, ${update.failed} failed)`);
});

reporter.start(pages.length);

for (const result of results) {
  reporter.update(result);
}

const summary = reporter.finish();
console.log('Final Summary:', summary);
```

---

**Roadmap Created:** October 23, 2025
**Status:** Ready for implementation
**Estimated Effort:** 3 weeks (Week 8-10)
