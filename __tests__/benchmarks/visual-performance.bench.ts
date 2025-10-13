/**
 * Visual regression performance benchmarks
 * Tests various scenarios to establish performance baselines and identify bottlenecks
 */

import { VisualDiffEngine } from '../../src/visual/diff';
import { StorageManager } from '../../src/visual/storage';
import sharp from 'sharp';
import { benchmark, benchmarkSuite, formatResults, saveBenchmarkResults } from './bench-utils';
import * as path from 'path';
import * as fs from 'fs';

const TEMP_DIR = '.iris-bench-visual';
const RESULTS_DIR = '.iris-bench-results';

/**
 * Generate test images of various sizes
 */
async function generateTestImage(
  width: number,
  height: number,
  pattern: 'solid' | 'gradient' | 'complex' = 'solid'
): Promise<Buffer> {
  if (pattern === 'solid') {
    return sharp({
      create: {
        width,
        height,
        channels: 4,
        background: { r: 128, g: 128, b: 128, alpha: 1 }
      }
    }).png().toBuffer();
  }

  if (pattern === 'gradient') {
    // Create gradient image
    const svg = `
      <svg width="${width}" height="${height}">
        <defs>
          <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" style="stop-color:rgb(255,255,0);stop-opacity:1" />
            <stop offset="100%" style="stop-color:rgb(255,0,0);stop-opacity:1" />
          </linearGradient>
        </defs>
        <rect width="${width}" height="${height}" fill="url(#grad)" />
      </svg>
    `;
    return sharp(Buffer.from(svg)).png().toBuffer();
  }

  // Complex pattern with text and shapes
  const svg = `
    <svg width="${width}" height="${height}">
      <rect width="${width}" height="${height}" fill="#f0f0f0"/>
      <circle cx="${width / 2}" cy="${height / 2}" r="${Math.min(width, height) / 4}" fill="#ff6b6b"/>
      <text x="${width / 2}" y="${height / 2}" font-size="24" text-anchor="middle" fill="#333">Test Content</text>
    </svg>
  `;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * Create slightly different version of image
 */
async function createVariant(baseBuffer: Buffer, changePercent: number = 5): Promise<Buffer> {
  const image = sharp(baseBuffer);
  const metadata = await image.metadata();
  const { width, height } = metadata;

  if (!width || !height) {
    throw new Error('Invalid image metadata');
  }

  // Add small changes (brightness adjustment)
  return image
    .modulate({ brightness: 1 + (changePercent / 100) })
    .png()
    .toBuffer();
}

/**
 * Benchmark: Single page visual diff
 */
async function benchmarkSinglePageDiff() {
  const diffEngine = new VisualDiffEngine();

  const baseline = await generateTestImage(1920, 1080, 'complex');
  const current = await createVariant(baseline, 2);

  return async () => {
    await diffEngine.compare(baseline, current, {
      threshold: 0.95,
      includeAA: true,
      alpha: 0.1,
      diffMask: true,
      diffColor: [255, 0, 0]
    });
  };
}

/**
 * Benchmark: Multi-page visual diff (sequential)
 */
async function benchmarkMultiPageSequential(pageCount: number) {
  const diffEngine = new VisualDiffEngine();
  const pages: Array<{ baseline: Buffer; current: Buffer }> = [];

  // Prepare test images
  for (let i = 0; i < pageCount; i++) {
    const baseline = await generateTestImage(1920, 1080, 'complex');
    const current = await createVariant(baseline, 2);
    pages.push({ baseline, current });
  }

  return async () => {
    for (const page of pages) {
      await diffEngine.compare(page.baseline, page.current, {
        threshold: 0.95,
        includeAA: true,
        alpha: 0.1,
        diffMask: true,
        diffColor: [255, 0, 0]
      });
    }
  };
}

/**
 * Benchmark: Multi-page visual diff (parallel)
 */
async function benchmarkMultiPageParallel(pageCount: number) {
  const diffEngine = new VisualDiffEngine();
  const pages: Array<{ baseline: Buffer; current: Buffer }> = [];

  for (let i = 0; i < pageCount; i++) {
    const baseline = await generateTestImage(1920, 1080, 'complex');
    const current = await createVariant(baseline, 2);
    pages.push({ baseline, current });
  }

  return async () => {
    await Promise.all(
      pages.map(page =>
        diffEngine.compare(page.baseline, page.current, {
          threshold: 0.95,
          includeAA: true,
          alpha: 0.1,
          diffMask: true,
          diffColor: [255, 0, 0]
        })
      )
    );
  };
}

/**
 * Benchmark: Multi-device visual diff
 */
async function benchmarkMultiDevice(deviceCount: number) {
  const diffEngine = new VisualDiffEngine();
  const devices = [
    { width: 1920, height: 1080, name: 'desktop' },
    { width: 768, height: 1024, name: 'tablet' },
    { width: 375, height: 667, name: 'mobile' },
    { width: 2560, height: 1440, name: '2k' },
    { width: 3840, height: 2160, name: '4k' },
    { width: 1366, height: 768, name: 'laptop' },
    { width: 414, height: 896, name: 'mobile-xl' },
    { width: 320, height: 568, name: 'mobile-sm' }
  ];

  const tests: Array<{ baseline: Buffer; current: Buffer }> = [];
  for (let i = 0; i < deviceCount; i++) {
    const device = devices[i % devices.length];
    const baseline = await generateTestImage(device.width, device.height, 'complex');
    const current = await createVariant(baseline, 2);
    tests.push({ baseline, current });
  }

  return async () => {
    await Promise.all(
      tests.map(test =>
        diffEngine.compare(test.baseline, test.current, {
          threshold: 0.95,
          includeAA: true,
          alpha: 0.1,
          diffMask: true,
          diffColor: [255, 0, 0]
        })
      )
    );
  };
}

/**
 * Benchmark: Cache hit performance
 */
async function benchmarkCacheHit() {
  const diffEngine = new VisualDiffEngine();

  const baseline = await generateTestImage(1920, 1080, 'complex');
  const current = await createVariant(baseline, 2);
  const options = {
    threshold: 0.95,
    includeAA: true,
    alpha: 0.1,
    diffMask: true,
    diffColor: [255, 0, 0] as [number, number, number]
  };

  // Prime the cache
  await diffEngine.compare(baseline, current, options);

  return async () => {
    await diffEngine.compare(baseline, current, options);
  };
}

/**
 * Benchmark: Cache miss performance
 */
async function benchmarkCacheMiss() {
  const diffEngine = new VisualDiffEngine();
  diffEngine.setCacheEnabled(false);

  const baseline = await generateTestImage(1920, 1080, 'complex');
  const current = await createVariant(baseline, 2);

  return async () => {
    await diffEngine.compare(baseline, current, {
      threshold: 0.95,
      includeAA: true,
      alpha: 0.1,
      diffMask: true,
      diffColor: [255, 0, 0]
    });
  };
}

/**
 * Benchmark: Image storage with compression
 */
async function benchmarkImageStorage() {
  const storageManager = new StorageManager(TEMP_DIR);
  const images: Buffer[] = [];

  // Generate test images
  for (let i = 0; i < 10; i++) {
    const img = await generateTestImage(1920, 1080, 'complex');
    images.push(img);
  }

  return async () => {
    for (let i = 0; i < images.length; i++) {
      await storageManager.saveImage('benchmark', `test-${i}`, images[i], {
        autoOptimize: true
      });
    }
  };
}

/**
 * Benchmark: Different image sizes
 */
async function benchmarkImageSize(width: number, height: number, label: string) {
  const diffEngine = new VisualDiffEngine();

  const baseline = await generateTestImage(width, height, 'complex');
  const current = await createVariant(baseline, 2);

  return async () => {
    await diffEngine.compare(baseline, current, {
      threshold: 0.95,
      includeAA: true,
      alpha: 0.1,
      diffMask: true,
      diffColor: [255, 0, 0]
    });
  };
}

/**
 * Benchmark: Early exit optimization
 */
async function benchmarkEarlyExit() {
  const diffEngine = new VisualDiffEngine();

  // Create very different images to trigger early exit
  const baseline = await generateTestImage(2560, 1440, 'solid');
  const current = await sharp({
    create: {
      width: 2560,
      height: 1440,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 }
    }
  }).png().toBuffer();

  return async () => {
    await diffEngine.compare(baseline, current, {
      threshold: 0.95,
      includeAA: true,
      alpha: 0.1,
      diffMask: true,
      diffColor: [255, 0, 0]
    });
  };
}

/**
 * Run all visual performance benchmarks
 */
async function runVisualBenchmarks() {
  console.log('🚀 Starting Visual Performance Benchmarks...\n');

  // Ensure directories exist
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
  if (!fs.existsSync(RESULTS_DIR)) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
  }

  const suite = await benchmarkSuite('Visual Regression Performance', [
    {
      name: 'Single Page (1920x1080)',
      fn: await benchmarkSinglePageDiff(),
      options: { iterations: 50, warmup: 5 }
    },
    {
      name: '10 Pages Sequential',
      fn: await benchmarkMultiPageSequential(10),
      options: { iterations: 10, warmup: 2 }
    },
    {
      name: '10 Pages Parallel',
      fn: await benchmarkMultiPageParallel(10),
      options: { iterations: 10, warmup: 2 }
    },
    {
      name: '50 Pages Sequential',
      fn: await benchmarkMultiPageSequential(50),
      options: { iterations: 3, warmup: 1 }
    },
    {
      name: '50 Pages Parallel',
      fn: await benchmarkMultiPageParallel(50),
      options: { iterations: 3, warmup: 1 }
    },
    {
      name: '2 Devices Parallel',
      fn: await benchmarkMultiDevice(2),
      options: { iterations: 20, warmup: 3 }
    },
    {
      name: '4 Devices Parallel',
      fn: await benchmarkMultiDevice(4),
      options: { iterations: 15, warmup: 3 }
    },
    {
      name: '8 Devices Parallel',
      fn: await benchmarkMultiDevice(8),
      options: { iterations: 10, warmup: 2 }
    },
    {
      name: 'Cache Hit',
      fn: await benchmarkCacheHit(),
      options: { iterations: 100, warmup: 10 }
    },
    {
      name: 'Cache Miss',
      fn: await benchmarkCacheMiss(),
      options: { iterations: 50, warmup: 5 }
    },
    {
      name: 'Image Storage (10 images)',
      fn: await benchmarkImageStorage(),
      options: { iterations: 5, warmup: 1 }
    },
    {
      name: 'HD (1280x720)',
      fn: await benchmarkImageSize(1280, 720, 'HD'),
      options: { iterations: 50, warmup: 5 }
    },
    {
      name: 'Full HD (1920x1080)',
      fn: await benchmarkImageSize(1920, 1080, 'Full HD'),
      options: { iterations: 50, warmup: 5 }
    },
    {
      name: '2K (2560x1440)',
      fn: await benchmarkImageSize(2560, 1440, '2K'),
      options: { iterations: 30, warmup: 3 }
    },
    {
      name: '4K (3840x2160)',
      fn: await benchmarkImageSize(3840, 2160, '4K'),
      options: { iterations: 15, warmup: 2 }
    },
    {
      name: 'Early Exit (Large Different Images)',
      fn: await benchmarkEarlyExit(),
      options: { iterations: 50, warmup: 5 }
    }
  ]);

  // Display results
  console.log(formatResults(suite));

  // Save results
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const resultsPath = path.join(RESULTS_DIR, `visual-perf-${timestamp}.json`);
  saveBenchmarkResults(suite, resultsPath);
  console.log(`✅ Results saved to: ${resultsPath}`);

  // Cleanup
  if (fs.existsSync(TEMP_DIR)) {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  }

  return suite;
}

// Run if executed directly
if (require.main === module) {
  runVisualBenchmarks()
    .then(() => {
      console.log('\n✅ All visual benchmarks completed!');
      process.exit(0);
    })
    .catch(error => {
      console.error('\n❌ Benchmark failed:', error);
      process.exit(1);
    });
}

export { runVisualBenchmarks };
