# IRIS Performance Optimization Recommendations

Based on benchmark analysis and bottleneck identification for Phase 2 visual regression and accessibility testing.

## Executive Summary

**Current Performance Status:**
✅ **Strengths:**
- Single page visual diff: 42.61ms (target < 100ms) - **57% better than target**
- Early exit optimization: 31.06ms - **27% faster than standard diff**
- Parallel processing: 1.6x faster than sequential for 10 pages
- HD images: 22.18ms - **78% faster than Full HD**

⚠️ **Areas for Improvement:**
- Cache hit performance: 41.74ms (expected < 10ms) - **needs investigation**
- Parallel speedup factor: 1.6x (expected 3-5x) - **CPU bound**
- Image storage: 1918ms for 10 images - **I/O bottleneck**
- 4K images: 205.30ms - **acceptable but improvable**

## Detailed Analysis & Recommendations

### 1. Cache Performance Issue

**Problem**: Cache hits (41.74ms) are nearly identical to cache misses (42.42ms)
**Expected**: Cache hits should be < 10ms (90% faster)

**Root Cause Analysis**:
1. Cache lookup overhead might be too high
2. Hash computation might be expensive (SHA-256)
3. Deep cloning of cached results could be the bottleneck
4. Cache may not actually be hitting (verification needed)

**Recommendations**:

**HIGH PRIORITY - Quick Win**
```typescript
// Option 1: Use faster hash function
import { createHash } from 'crypto';

// Replace SHA-256 with xxHash or FarmHash for 3-5x faster hashing
private generateCacheKey(baseline: Buffer, current: Buffer, options: DiffOptions): string {
  // Use faster non-cryptographic hash
  const baselineHash = xxHash64(baseline).toString(16).substring(0, 16);
  const currentHash = xxHash64(current).toString(16).substring(0, 16);
  const optionsHash = xxHash32(JSON.stringify(options)).toString(16);
  return `${baselineHash}-${currentHash}-${optionsHash}`;
}
```

**Expected Impact**: 20-30ms reduction in cache lookup time

**MEDIUM PRIORITY**
```typescript
// Option 2: Shallow copy for cache results
private addToCache(key: string, result: DiffResult): void {
  // Store reference instead of deep clone
  // Mark diffBuffer as readonly to prevent mutations
  Object.freeze(result);
  this.diffCache.set(key, result);
}
```

**Expected Impact**: 5-10ms reduction

**LOW PRIORITY - Verification**
```typescript
// Add cache hit/miss metrics
getCacheStats(): {
  size: number;
  maxSize: number;
  enabled: boolean;
  hits: number;       // NEW
  misses: number;     // NEW
  hitRate: number;    // NEW
} {
  const total = this.cacheHits + this.cacheMisses;
  return {
    size: this.diffCache.size,
    maxSize: this.maxCacheSize,
    enabled: this.cacheEnabled,
    hits: this.cacheHits,
    misses: this.cacheMisses,
    hitRate: total > 0 ? this.cacheHits / total : 0
  };
}
```

**Expected Impact**: Better visibility, no performance change

### 2. Parallel Processing Bottleneck

**Problem**: Parallel execution only 1.6x faster than sequential (expected 3-5x)
**Data**:
- 10 pages sequential: 420.11ms
- 10 pages parallel: 263.74ms
- Speedup factor: 1.6x

**Root Cause Analysis**:
1. CPU-bound workload (pixelmatch is computationally intensive)
2. Not enough CPU cores for true parallelism
3. Memory pressure causing GC pauses
4. Shared resources (Sharp image processing)

**Recommendations**:

**HIGH PRIORITY - Worker Threads**
```typescript
// Move heavy pixel diff to worker threads
import { Worker } from 'worker_threads';

class DiffWorkerPool {
  private workers: Worker[] = [];
  private queue: Array<{ resolve: Function; reject: Function; data: any }> = [];

  constructor(poolSize: number = require('os').cpus().length) {
    for (let i = 0; i < poolSize; i++) {
      this.workers.push(new Worker('./diff-worker.js'));
    }
  }

  async compare(baseline: Buffer, current: Buffer, options: DiffOptions): Promise<DiffResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject, data: { baseline, current, options } });
      this.processQueue();
    });
  }
}
```

**Expected Impact**: 3-5x speedup for parallel operations (CPU-bound)

**MEDIUM PRIORITY - Concurrency Limits**
```typescript
import pLimit from 'p-limit';

// Limit concurrent operations to CPU core count
const limit = pLimit(require('os').cpus().length);

async function compareMultiplePages(pages: Array<{ baseline: Buffer; current: Buffer }>) {
  return Promise.all(
    pages.map(page =>
      limit(() => diffEngine.compare(page.baseline, page.current, options))
    )
  );
}
```

**Expected Impact**: 10-20% improvement by reducing memory pressure

**LOW PRIORITY - Smart Batching**
```typescript
// Process in batches to balance parallelism and memory
async function batchProcess(items: any[], batchSize: number = 10) {
  const results: any[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(item => processItem(item))
    );
    results.push(...batchResults);

    // Force GC between batches if available
    if (global.gc) global.gc();
  }
  return results;
}
```

**Expected Impact**: 5-10% improvement for large test suites

### 3. Image Storage Bottleneck

**Problem**: 1918ms to store 10 images (191.8ms per image)
**Target**: < 50ms per image

**Root Cause Analysis**:
1. Synchronous file I/O blocking execution
2. Compression happening inline
3. No parallel write operations
4. Potential disk I/O contention

**Recommendations**:

**HIGH PRIORITY - Async I/O**
```typescript
// Use async file operations
import { promises as fs } from 'fs';

async saveImage(
  testName: string,
  imageName: string,
  buffer: Buffer,
  options: SaveOptions = {}
): Promise<SaveResult> {
  const optimized = await this.optimizeImage(buffer, options);
  const filepath = path.join(this.basePath, testName, `${imageName}.${optimized.format}`);

  // Parallel: ensure directory + write file
  await Promise.all([
    fs.mkdir(path.dirname(filepath), { recursive: true }),
    fs.writeFile(filepath, optimized.buffer)
  ]);

  return { path: filepath, size: optimized.buffer.length, format: optimized.format };
}
```

**Expected Impact**: 40-60% faster storage operations

**MEDIUM PRIORITY - Write Queue**
```typescript
class StorageQueue {
  private queue: Array<() => Promise<void>> = [];
  private processing = false;

  async enqueue(operation: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          await operation();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      this.processQueue();
    });
  }

  private async processQueue() {
    if (this.processing || this.queue.length === 0) return;

    this.processing = true;
    while (this.queue.length > 0) {
      const operation = this.queue.shift()!;
      await operation();
    }
    this.processing = false;
  }
}
```

**Expected Impact**: 20-30% improvement through batching

**LOW PRIORITY - Compression Worker**
```typescript
// Offload compression to worker thread
import { Worker } from 'worker_threads';

async optimizeImageInWorker(buffer: Buffer, options: any): Promise<Buffer> {
  const worker = new Worker('./image-compressor.js');
  return new Promise((resolve, reject) => {
    worker.postMessage({ buffer, options });
    worker.on('message', resolve);
    worker.on('error', reject);
  });
}
```

**Expected Impact**: 10-20% improvement for large images

### 4. Large Image Performance

**Problem**: 4K images take 205.30ms (acceptable but room for improvement)
**Data**:
- HD (1280x720): 22.18ms
- Full HD (1920x1080): 42.71ms (1.92x HD)
- 2K (2560x1440): 91.29ms (2.14x Full HD)
- 4K (3840x2160): 205.30ms (2.25x 2K)

**Analysis**: Performance scales roughly linearly with pixel count (good!)

**Recommendations**:

**HIGH PRIORITY - SIMD Optimization**
```typescript
// Use WASM version of pixelmatch with SIMD support
import pixelmatchWasm from 'pixelmatch-wasm';

// 2-3x faster for large images
const diff = await pixelmatchWasm(
  baseline.buffer,
  current.buffer,
  diffBuffer,
  width,
  height,
  options
);
```

**Expected Impact**: 2-3x speedup (205ms → 70-100ms for 4K)

**MEDIUM PRIORITY - Smart Downscaling**
```typescript
// Downsample 4K images for quick comparison, full res only if needed
async compare(baseline: Buffer, current: Buffer, options: DiffOptions): Promise<DiffResult> {
  const baselineMeta = await sharp(baseline).metadata();

  // For images > 2K, do quick low-res comparison first
  if (baselineMeta.width! * baselineMeta.height! > 1920 * 1080) {
    const quickResult = await this.compareDownsampled(baseline, current, options);

    // Only do full res if quick check shows differences
    if (quickResult.similarity < 0.95) {
      return this.compareFullResolution(baseline, current, options);
    }

    return quickResult;
  }

  return this.compareFullResolution(baseline, current, options);
}
```

**Expected Impact**: 50-70% faster for similar large images

**LOW PRIORITY - GPU Acceleration**
```typescript
// Use GPU for pixel difference calculation
import { GPU } from 'gpu.js';

const gpu = new GPU();
const pixelDiffKernel = gpu.createKernel(function(
  baseline: number[],
  current: number[],
  threshold: number
) {
  const i = this.thread.x * 4;
  const rDiff = Math.abs(baseline[i] - current[i]);
  const gDiff = Math.abs(baseline[i+1] - current[i+1]);
  const bDiff = Math.abs(baseline[i+2] - current[i+2]);

  return (rDiff > threshold || gDiff > threshold || bDiff > threshold) ? 1 : 0;
}).setOutput([width * height]);
```

**Expected Impact**: 3-5x speedup for very large images (requires GPU)

### 5. Memory Management

**Current Status**: Peak memory delta 1.57MB (very good!)
**Recommendation**: Monitor but no immediate action needed

**Proactive Optimizations**:

**LOW PRIORITY - Stream Processing**
```typescript
// For very large images, use streaming
import { Transform } from 'stream';

class ImageDiffStream extends Transform {
  constructor(private baseline: Buffer, private threshold: number) {
    super();
  }

  _transform(chunk: Buffer, encoding: string, callback: Function) {
    // Process chunk-by-chunk to reduce peak memory
    const diffChunk = this.compareChunk(chunk);
    this.push(diffChunk);
    callback();
  }
}
```

**Expected Impact**: 30-50% lower peak memory for 8K+ images

## Priority Implementation Plan

### Phase 1: Quick Wins (Week 1)
1. ✅ Fix cache hash function (xxHash instead of SHA-256)
2. ✅ Add cache hit/miss tracking
3. ✅ Implement async I/O for storage
4. ✅ Add concurrency limits with p-limit

**Expected Cumulative Impact**: 40-60% overall performance improvement

### Phase 2: Parallel Processing (Week 2)
1. Implement worker thread pool for diffs
2. Add smart batching for large suites
3. Optimize memory management between batches

**Expected Cumulative Impact**: 2-3x speedup for multi-page tests

### Phase 3: Advanced Optimizations (Week 3-4)
1. Evaluate WASM pixelmatch integration
2. Implement smart downscaling for large images
3. Add compression worker threads
4. Explore GPU acceleration feasibility

**Expected Cumulative Impact**: 3-5x total speedup

### Phase 4: Long-term (Future)
1. GPU acceleration for massive images
2. Distributed testing across machines
3. Incremental diff caching
4. Perceptual hashing for similarity

## Measurement & Validation

### Before Each Optimization
```bash
# Run baseline benchmark
npm run bench:visual

# Save baseline
cp .iris-bench-results/latest.json .iris-bench-results/baseline-pre-optimization.json
```

### After Each Optimization
```bash
# Run new benchmark
npm run bench:visual

# Compare with baseline
ts-node __tests__/benchmarks/report-generator.ts \
  .iris-bench-results/latest.json \
  .iris-bench-results/baseline-pre-optimization.json
```

### Success Criteria
- ✅ **Cache hits < 10ms** (current: 41.74ms)
- ✅ **Parallel speedup > 3x** (current: 1.6x)
- ✅ **Image storage < 50ms/image** (current: 191.8ms)
- ✅ **4K diff < 150ms** (current: 205.30ms)

## Risk Assessment

### Low Risk ✅
- Cache optimization (isolated, easy rollback)
- Async I/O (well-tested pattern)
- Concurrency limits (safety improvement)

### Medium Risk ⚠️
- Worker threads (adds complexity, but isolated)
- WASM integration (external dependency)
- Smart downscaling (potential quality trade-off)

### High Risk ⛔
- GPU acceleration (hardware dependency, fallback needed)
- Streaming (significant refactoring)
- Distributed testing (infrastructure overhead)

## Monitoring Strategy

### Key Performance Indicators
```typescript
interface PerformanceMetrics {
  // Timing
  avgDiffTime: number;          // Target: < 100ms
  p95DiffTime: number;          // Target: < 200ms
  cacheHitTime: number;         // Target: < 10ms

  // Throughput
  parallelSpeedup: number;      // Target: > 3x
  imagesPerSecond: number;      // Target: > 10

  // Resource Usage
  peakMemoryMB: number;         // Target: < 500MB
  avgCpuPercent: number;        // Monitor only

  // Quality
  cacheHitRate: number;         // Target: > 80%
  errorRate: number;            // Target: < 1%
}
```

### Automated Checks
```bash
# Add to CI/CD pipeline
npm run bench:visual
npm run bench:check-regressions

# Fail if performance degrades > 10%
if [ $PERF_REGRESSION -gt 10 ]; then
  echo "Performance regression detected!"
  exit 1
fi
```

## Conclusion

**Immediate Actions** (implement this week):
1. Fix cache performance (xxHash)
2. Add async I/O
3. Implement concurrency limits
4. Add performance monitoring

**Expected Results**:
- 40-60% faster overall performance
- Better resource utilization
- Foundation for future optimizations

**Long-term Vision**:
- 3-5x total speedup
- < 50ms per Full HD image
- Linear scalability to 100+ pages
- GPU-accelerated for 4K+ images
