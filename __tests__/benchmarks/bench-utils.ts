/**
 * Benchmark utilities for performance testing
 */

export interface BenchmarkResult {
  name: string;
  iterations: number;
  totalTime: number;
  avgTime: number;
  minTime: number;
  maxTime: number;
  throughput: number;
  memoryUsage: {
    heapUsed: number;
    heapTotal: number;
    external: number;
    rss: number;
  };
}

export interface BenchmarkSuite {
  name: string;
  results: BenchmarkResult[];
  summary: {
    totalDuration: number;
    totalIterations: number;
    avgThroughput: number;
    peakMemory: number;
  };
}

/**
 * Benchmark a function and collect performance metrics
 */
export async function benchmark(
  name: string,
  fn: () => Promise<void> | void,
  options: {
    iterations?: number;
    warmup?: number;
    timeout?: number;
  } = {}
): Promise<BenchmarkResult> {
  const { iterations = 10, warmup = 2, timeout = 60000 } = options;

  // Warmup runs
  for (let i = 0; i < warmup; i++) {
    await fn();
  }

  // Force garbage collection if available
  if (global.gc) {
    global.gc();
  }

  const times: number[] = [];
  const startMemory = process.memoryUsage();
  const overallStart = Date.now();

  // Benchmark runs
  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime.bigint();
    await fn();
    const end = process.hrtime.bigint();
    const duration = Number(end - start) / 1_000_000; // Convert to milliseconds
    times.push(duration);

    // Check timeout
    if (Date.now() - overallStart > timeout) {
      console.warn(`Benchmark ${name} timed out after ${i + 1} iterations`);
      break;
    }
  }

  const endMemory = process.memoryUsage();
  const totalTime = times.reduce((sum, t) => sum + t, 0);
  const avgTime = totalTime / times.length;
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const throughput = 1000 / avgTime; // Operations per second

  return {
    name,
    iterations: times.length,
    totalTime,
    avgTime,
    minTime,
    maxTime,
    throughput,
    memoryUsage: {
      heapUsed: endMemory.heapUsed - startMemory.heapUsed,
      heapTotal: endMemory.heapTotal - startMemory.heapTotal,
      external: endMemory.external - startMemory.external,
      rss: endMemory.rss - startMemory.rss,
    },
  };
}

/**
 * Run a suite of benchmarks
 */
export async function benchmarkSuite(
  name: string,
  benchmarks: Array<{ name: string; fn: () => Promise<void> | void; options?: any }>
): Promise<BenchmarkSuite> {
  const results: BenchmarkResult[] = [];
  const suiteStart = Date.now();

  for (const bench of benchmarks) {
    console.log(`Running benchmark: ${bench.name}...`);
    const result = await benchmark(bench.name, bench.fn, bench.options);
    results.push(result);
    console.log(`  ✓ ${result.avgTime.toFixed(2)}ms avg (${result.throughput.toFixed(2)} ops/sec)`);
  }

  const suiteDuration = Date.now() - suiteStart;
  const totalIterations = results.reduce((sum, r) => sum + r.iterations, 0);
  const avgThroughput = results.reduce((sum, r) => sum + r.throughput, 0) / results.length;
  const peakMemory = Math.max(...results.map(r => r.memoryUsage.heapUsed));

  return {
    name,
    results,
    summary: {
      totalDuration: suiteDuration,
      totalIterations,
      avgThroughput,
      peakMemory,
    },
  };
}

/**
 * Format benchmark results as table
 */
export function formatResults(suite: BenchmarkSuite): string {
  const lines: string[] = [];
  lines.push(`\n${'='.repeat(100)}`);
  lines.push(`Benchmark Suite: ${suite.name}`);
  lines.push(`${'='.repeat(100)}`);
  lines.push(
    `| ${'Benchmark'.padEnd(40)} | ${'Avg Time'.padStart(12)} | ${'Min Time'.padStart(12)} | ${'Max Time'.padStart(12)} | ${'Throughput'.padStart(15)} |`
  );
  lines.push(`| ${'-'.repeat(40)} | ${'-'.repeat(12)} | ${'-'.repeat(12)} | ${'-'.repeat(12)} | ${'-'.repeat(15)} |`);

  for (const result of suite.results) {
    const name = result.name.length > 40 ? result.name.substring(0, 37) + '...' : result.name;
    lines.push(
      `| ${name.padEnd(40)} | ${result.avgTime.toFixed(2).padStart(10)}ms | ${result.minTime.toFixed(2).padStart(10)}ms | ${result.maxTime.toFixed(2).padStart(10)}ms | ${result.throughput.toFixed(2).padStart(12)} op/s |`
    );
  }

  lines.push(`${'='.repeat(100)}`);
  lines.push(`Summary:`);
  lines.push(`  Total Duration: ${suite.summary.totalDuration}ms`);
  lines.push(`  Total Iterations: ${suite.summary.totalIterations}`);
  lines.push(`  Average Throughput: ${suite.summary.avgThroughput.toFixed(2)} ops/sec`);
  lines.push(`  Peak Memory Delta: ${(suite.summary.peakMemory / (1024 * 1024)).toFixed(2)}MB`);
  lines.push(`${'='.repeat(100)}\n`);

  return lines.join('\n');
}

/**
 * Save benchmark results to JSON file
 */
export function saveBenchmarkResults(suite: BenchmarkSuite, filepath: string): void {
  const fs = require('fs');
  const results = {
    ...suite,
    timestamp: new Date().toISOString(),
    platform: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpus: require('os').cpus().length,
      memory: require('os').totalmem(),
    },
  };
  fs.writeFileSync(filepath, JSON.stringify(results, null, 2));
}

/**
 * Compare two benchmark results
 */
export function compareBenchmarks(
  baseline: BenchmarkResult,
  current: BenchmarkResult
): {
  speedup: number;
  percentChange: number;
  faster: boolean;
  significantChange: boolean;
} {
  const speedup = baseline.avgTime / current.avgTime;
  const percentChange = ((current.avgTime - baseline.avgTime) / baseline.avgTime) * 100;
  const faster = current.avgTime < baseline.avgTime;
  const significantChange = Math.abs(percentChange) > 5; // 5% threshold

  return {
    speedup,
    percentChange,
    faster,
    significantChange,
  };
}
