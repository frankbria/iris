# Visual Regression Testing API

Complete API reference for IRIS visual regression testing features.

## Table of Contents

- [Overview](#overview)
- [Core Types](#core-types)
- [Visual Test Runner](#visual-test-runner)
- [Visual Diff Engine](#visual-diff-engine)
- [Visual Capture Engine](#visual-capture-engine)
- [Baseline Manager](#baseline-manager)
- [AI Visual Classifier](#ai-visual-classifier)
- [Storage Manager](#storage-manager)
- [Error Handling](#error-handling)
- [Examples](#examples)

---

## Overview

The visual regression testing module provides comprehensive tools for capturing, comparing, and analyzing visual differences in web applications. It combines pixel-perfect comparison with AI-powered semantic analysis.

### Quick Example

```typescript
import { VisualTestRunner } from '@iris/visual';

const runner = new VisualTestRunner({
  pages: ['/home', '/about', '/contact'],
  baseline: {
    strategy: 'branch',
    reference: 'main'
  },
  capture: {
    viewport: { width: 1920, height: 1080 },
    fullPage: true
  },
  diff: {
    threshold: 0.1,
    semanticAnalysis: true
  }
});

const result = await runner.run();
console.log(`Overall status: ${result.summary.overallStatus}`);
console.log(`Comparisons: ${result.summary.totalComparisons}`);
```

---

## Core Types

### VisualTestConfig

Configuration for a single visual test.

```typescript
interface VisualTestConfig {
  testName: string;                    // Unique test identifier
  url: string;                         // URL to test
  viewport?: Viewport;                 // Optional viewport dimensions
  selector?: string;                   // Optional element selector
  threshold?: number;                  // Similarity threshold (0-1), default: 0.1
  ignoreRegions?: IgnoreRegion[];     // Areas to exclude from comparison
  waitForSelector?: string;            // Wait for element before capture
  waitForTimeout?: number;             // Max wait time in ms, default: 5000
  disableAnimations?: boolean;         // Disable animations, default: true
  fullPage?: boolean;                  // Capture full page, default: false
  clip?: ClipRegion;                  // Specific region to capture
}
```

**Example:**

```typescript
const config: VisualTestConfig = {
  testName: 'homepage-hero',
  url: 'https://example.com',
  viewport: { width: 1920, height: 1080 },
  selector: '.hero-section',
  threshold: 0.05,
  ignoreRegions: [
    { x: 100, y: 50, width: 200, height: 100 } // Skip dynamic content
  ],
  waitForSelector: '.hero-loaded',
  disableAnimations: true
};
```

### VisualDiffResult

Result of a visual comparison.

```typescript
interface VisualDiffResult {
  testName: string;
  passed: boolean;                    // Whether test passed threshold
  similarity: number;                 // Similarity score (0-1)
  pixelDifference: number;           // Number of different pixels
  threshold: number;                 // Applied threshold
  baselineExists: boolean;           // Whether baseline was found
  screenshotPath: string;            // Path to current screenshot
  baselinePath?: string;             // Path to baseline
  diffPath?: string;                 // Path to diff image
  timestamp: Date;                   // Test execution time
  viewport: Viewport;                // Viewport used
  metadata?: Record<string, any>;    // Additional metadata
}
```

### Viewport

```typescript
interface Viewport {
  width: number;   // Width in pixels (min: 320)
  height: number;  // Height in pixels (min: 240)
}
```

### IgnoreRegion

Region to exclude from comparison.

```typescript
interface IgnoreRegion {
  x: number;       // X coordinate
  y: number;       // Y coordinate
  width: number;   // Region width
  height: number;  // Region height
}
```

### ClipRegion

Region to capture (same as IgnoreRegion).

```typescript
type ClipRegion = IgnoreRegion;
```

---

## Visual Test Runner

High-level orchestrator for running visual regression tests.

### Constructor

```typescript
class VisualTestRunner {
  constructor(config: VisualTestRunnerConfig);
}
```

### VisualTestRunnerConfig

```typescript
interface VisualTestRunnerConfig {
  pages: string[];                    // URL patterns to test
  baseline: {
    strategy: 'branch' | 'commit' | 'tag';
    reference: string;                // Git reference for baselines
  };
  capture: {
    viewport: Viewport;
    fullPage: boolean;
    mask?: string[];                  // CSS selectors to mask
    format?: 'png' | 'jpeg';
    quality?: number;                 // JPEG quality (0-100)
    stabilization: {
      waitForFonts: boolean;
      disableAnimations: boolean;
      delay: number;                  // Milliseconds to wait
      waitForNetworkIdle: boolean;
      networkIdleTimeout: number;
    };
  };
  diff: {
    threshold: number;                // Similarity threshold (0-1)
    semanticAnalysis: boolean;        // Enable AI analysis
    aiProvider?: 'openai' | 'claude' | 'ollama';
    antiAliasing: boolean;
    regions?: IgnoreRegion[];
    maxConcurrency: number;           // Max parallel comparisons
  };
  devices: string[];                  // Device types to test
  updateBaseline: boolean;            // Update baselines with current
  failOn: 'breaking' | 'moderate' | 'minor';  // Failure threshold
  output: {
    format: 'html' | 'json' | 'junit';
    path?: string;
  };
}
```

### run()

Execute visual regression tests.

```typescript
async run(): Promise<VisualTestResult>;
```

**Returns:** Complete test results with summary and comparisons.

**Example:**

```typescript
const runner = new VisualTestRunner({
  pages: ['/home', '/products'],
  baseline: {
    strategy: 'branch',
    reference: 'main'
  },
  capture: {
    viewport: { width: 1920, height: 1080 },
    fullPage: true,
    mask: ['.timestamp', '.ad-banner'],
    format: 'png',
    stabilization: {
      waitForFonts: true,
      disableAnimations: true,
      delay: 500,
      waitForNetworkIdle: true,
      networkIdleTimeout: 2000
    }
  },
  diff: {
    threshold: 0.1,
    semanticAnalysis: true,
    aiProvider: 'openai',
    antiAliasing: true,
    maxConcurrency: 3
  },
  devices: ['desktop', 'mobile'],
  updateBaseline: false,
  failOn: 'breaking',
  output: {
    format: 'html',
    path: './reports/visual-regression.html'
  }
});

const result = await runner.run();

if (result.summary.overallStatus === 'passed') {
  console.log('✅ All visual tests passed');
} else {
  console.log(`❌ Visual regression detected:`);
  console.log(`   Breaking: ${result.summary.severityCounts.breaking}`);
  console.log(`   Moderate: ${result.summary.severityCounts.moderate}`);
  console.log(`   Minor: ${result.summary.severityCounts.minor}`);
}
```

---

## Visual Diff Engine

Performs pixel-level and SSIM comparison of images.

### Constructor

```typescript
class VisualDiffEngine {
  constructor();
}
```

### compare()

Compare two images using pixel matching.

```typescript
async compare(
  baselineBuffer: Buffer,
  currentBuffer: Buffer,
  options: DiffOptions
): Promise<DiffResult>;
```

**Parameters:**
- `baselineBuffer` - Baseline image as Buffer
- `currentBuffer` - Current screenshot as Buffer
- `options` - Comparison options

**DiffOptions:**

```typescript
interface DiffOptions {
  threshold: number;              // Similarity threshold (0-1)
  includeAA: boolean;            // Include anti-aliasing detection
  alpha: number;                 // Alpha threshold (0-1)
  diffMask: boolean;             // Generate diff mask
  diffColor: [number, number, number];  // RGB color for differences
}
```

**DiffResult:**

```typescript
interface DiffResult {
  success: boolean;
  passed: boolean;               // Whether similarity >= threshold
  similarity: number;            // Similarity score (0-1)
  pixelDifference: number;      // Count of different pixels
  threshold: number;
  diffBuffer?: Buffer;          // PNG image showing differences
  error?: string;
}
```

**Example:**

```typescript
import { VisualDiffEngine } from '@iris/visual';
import fs from 'fs';

const engine = new VisualDiffEngine();

const baseline = fs.readFileSync('./baseline.png');
const current = fs.readFileSync('./current.png');

const result = await engine.compare(baseline, current, {
  threshold: 0.95,
  includeAA: true,
  alpha: 0.1,
  diffMask: true,
  diffColor: [255, 0, 0]
});

if (result.passed) {
  console.log(`✅ Images match (${(result.similarity * 100).toFixed(2)}% similar)`);
} else {
  console.log(`❌ Images differ (${result.pixelDifference} pixels)`);
  if (result.diffBuffer) {
    fs.writeFileSync('./diff.png', result.diffBuffer);
  }
}
```

### ssimCompare()

Compare images using Structural Similarity Index (SSIM).

```typescript
async ssimCompare(
  baselineBuffer: Buffer,
  currentBuffer: Buffer
): Promise<SSIMResult>;
```

**SSIMResult:**

```typescript
interface SSIMResult {
  success: boolean;
  ssim?: number;    // SSIM score (0-1)
  mcs?: number;     // Multi-scale SSIM
  error?: string;
}
```

**Example:**

```typescript
const ssimResult = await engine.ssimCompare(baseline, current);

if (ssimResult.success) {
  console.log(`SSIM: ${ssimResult.ssim}`);
  console.log(`MCS: ${ssimResult.mcs}`);
}
```

### analyzeRegions()

Detect and analyze regions of difference.

```typescript
async analyzeRegions(
  diffBuffer: Buffer,
  width: number,
  height: number
): Promise<DiffRegion[]>;
```

**DiffRegion:**

```typescript
interface DiffRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  significance: number;  // 0-1 score
}
```

**Example:**

```typescript
const regions = await engine.analyzeRegions(
  result.diffBuffer,
  1920,
  1080
);

console.log(`Found ${regions.length} difference regions:`);
regions.forEach(region => {
  console.log(`  - ${region.width}x${region.height} at (${region.x},${region.y})`);
  console.log(`    Significance: ${(region.significance * 100).toFixed(1)}%`);
});
```

### classifyChange()

Classify the type of visual change.

```typescript
classifyChange(analysis: DiffAnalysis):
  'layout' | 'content' | 'styling' | 'animation' | 'unknown';
```

**DiffAnalysis:**

```typescript
interface DiffAnalysis {
  similarity: number;
  pixelDifference: number;
  regions: DiffRegion[];
  classification: 'layout' | 'content' | 'styling' | 'animation' | 'unknown';
}
```

### getSeverity()

Determine severity of visual changes.

```typescript
getSeverity(analysis: DiffAnalysis):
  'low' | 'medium' | 'high' | 'critical';
```

---

## Visual Capture Engine

Captures screenshots with stabilization and consistency.

### Constructor

```typescript
class VisualCaptureEngine {
  constructor();
}
```

### capture()

Capture a screenshot from a Playwright page.

```typescript
async capture(
  page: Page,
  config: CaptureConfig
): Promise<CaptureResult>;
```

**CaptureConfig:**

```typescript
interface CaptureConfig {
  selector?: string;              // Optional element to capture
  fullPage: boolean;             // Capture entire page
  maskSelectors: string[];       // Elements to mask
  stabilizeMs: number;           // Wait time for stabilization
  disableAnimations: boolean;    // Disable CSS animations
  clip?: ClipRegion;            // Specific region to capture
  quality?: number;              // JPEG quality (0-100)
  type?: 'png' | 'jpeg';
}
```

**CaptureResult:**

```typescript
interface CaptureResult {
  success: boolean;
  buffer?: Buffer;              // Image data
  metadata: CaptureMetadata;
  error?: string;
}
```

**CaptureMetadata:**

```typescript
interface CaptureMetadata {
  url: string;
  title: string;
  fullPage: boolean;
  viewport: Viewport;
  hash: string;                // SHA-256 hash of image
  timestamp: number;
  selector?: string;
  maskSelectors?: string[];
  stabilizeMs?: number;
  disableAnimations?: boolean;
}
```

**Example:**

```typescript
import { VisualCaptureEngine } from '@iris/visual';
import { chromium } from 'playwright';

const engine = new VisualCaptureEngine();
const browser = await chromium.launch();
const page = await browser.newPage();

await page.goto('https://example.com');

const result = await engine.capture(page, {
  fullPage: true,
  maskSelectors: ['.timestamp', '.ad'],
  stabilizeMs: 500,
  disableAnimations: true,
  type: 'png'
});

if (result.success) {
  console.log('Screenshot captured:');
  console.log(`  URL: ${result.metadata.url}`);
  console.log(`  Hash: ${result.metadata.hash}`);
  console.log(`  Size: ${result.buffer.length} bytes`);
}

await browser.close();
```

---

## Baseline Manager

Manages baseline images with Git integration.

### Constructor

```typescript
class BaselineManager {
  constructor(baselineDir: string);
}
```

**Parameters:**
- `baselineDir` - Directory for baseline storage

### save()

Save a baseline image.

```typescript
async save(
  testName: string,
  imageBuffer: Buffer,
  metadata: BaselineMetadata
): Promise<BaselineSaveResult>;
```

**BaselineMetadata:**

```typescript
interface BaselineMetadata {
  url: string;
  title: string;
  timestamp: number;
  viewport: Viewport;
  gitBranch?: string;
  gitCommit?: string;
  [key: string]: any;         // Additional custom metadata
}
```

**BaselineSaveResult:**

```typescript
interface BaselineSaveResult {
  success: boolean;
  path?: string;
  error?: string;
}
```

**Example:**

```typescript
import { BaselineManager } from '@iris/visual';

const manager = new BaselineManager('./baselines');

const saveResult = await manager.save(
  'homepage-desktop',
  screenshotBuffer,
  {
    url: 'https://example.com',
    title: 'Example Homepage',
    timestamp: Date.now(),
    viewport: { width: 1920, height: 1080 },
    gitBranch: 'main',
    gitCommit: 'abc123'
  }
);

if (saveResult.success) {
  console.log(`Baseline saved: ${saveResult.path}`);
}
```

### load()

Load a baseline image.

```typescript
async load(testName: string): Promise<BaselineLoadResult>;
```

**BaselineLoadResult:**

```typescript
interface BaselineLoadResult {
  success: boolean;
  buffer?: Buffer;
  metadata?: BaselineMetadata;
  error?: string;
}
```

### exists()

Check if a baseline exists.

```typescript
async exists(testName: string): Promise<BaselineInfo>;
```

**BaselineInfo:**

```typescript
interface BaselineInfo {
  exists: boolean;
  path?: string;
  lastModified?: Date;
  gitBranch?: string;
  gitCommit?: string;
}
```

### delete()

Delete a baseline.

```typescript
async delete(testName: string): Promise<BaselineDeleteResult>;
```

### cleanup()

Clean up old baselines.

```typescript
async cleanup(maxAge: number): Promise<BaselineCleanupResult>;
```

**Parameters:**
- `maxAge` - Maximum age in days

---

## AI Visual Classifier

AI-powered semantic analysis of visual changes.

### Constructor

```typescript
class AIVisualClassifier {
  constructor(config: AIProviderConfig);
}
```

**AIProviderConfig:**

```typescript
interface AIProviderConfig {
  provider: 'openai' | 'claude' | 'ollama';
  apiKey?: string;              // Required for OpenAI/Claude
  model?: string;               // Optional model override
  baseURL?: string;             // For Ollama
  maxTokens?: number;           // Default: 2048
  temperature?: number;         // Default: 0.1
}
```

**Example:**

```typescript
import { AIVisualClassifier } from '@iris/visual';

const classifier = new AIVisualClassifier({
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4-vision-preview',
  maxTokens: 2048,
  temperature: 0.1
});
```

### analyzeChange()

Analyze visual changes with AI.

```typescript
async analyzeChange(request: AIAnalysisRequest): Promise<AIAnalysisResponse>;
```

**AIAnalysisRequest:**

```typescript
interface AIAnalysisRequest {
  baselineImage: Buffer;
  currentImage: Buffer;
  diffImage?: Buffer;
  context?: {
    testName?: string;
    url?: string;
    viewport?: Viewport;
    gitBranch?: string;
  };
}
```

**AIAnalysisResponse:**

```typescript
interface AIAnalysisResponse {
  classification: string;                    // 'intentional' | 'regression' | 'unknown'
  confidence: number;                        // 0-1 confidence score
  description: string;                       // Detailed analysis
  severity: 'low' | 'medium' | 'high' | 'critical';
  suggestions: string[];                     // Actionable recommendations
  isIntentional: boolean;
  changeType: 'layout' | 'color' | 'content' | 'typography' | 'animation' | 'unknown';
  reasoning: string;                         // Why this classification
  regions?: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
    type: string;                           // 'header' | 'nav' | 'content' | etc.
    description: string;
  }>;
}
```

**Example:**

```typescript
const analysis = await classifier.analyzeChange({
  baselineImage: baselineBuffer,
  currentImage: currentBuffer,
  diffImage: diffBuffer,
  context: {
    testName: 'homepage-desktop',
    url: 'https://example.com',
    viewport: { width: 1920, height: 1080 },
    gitBranch: 'feature/redesign'
  }
});

console.log(`Classification: ${analysis.classification}`);
console.log(`Confidence: ${(analysis.confidence * 100).toFixed(1)}%`);
console.log(`Severity: ${analysis.severity}`);
console.log(`Is Intentional: ${analysis.isIntentional}`);
console.log(`Change Type: ${analysis.changeType}`);
console.log(`\nDescription: ${analysis.description}`);
console.log(`\nReasoning: ${analysis.reasoning}`);
console.log(`\nSuggestions:`);
analysis.suggestions.forEach(s => console.log(`  - ${s}`));
```

### batchAnalyze()

Analyze multiple visual changes in batch.

```typescript
async batchAnalyze(requests: AIAnalysisRequest[]): Promise<AIAnalysisResponse[]>;
```

**Example:**

```typescript
const analyses = await classifier.batchAnalyze([
  {
    baselineImage: baseline1,
    currentImage: current1
  },
  {
    baselineImage: baseline2,
    currentImage: current2
  }
]);

analyses.forEach((analysis, i) => {
  console.log(`\nAnalysis ${i + 1}:`);
  console.log(`  Classification: ${analysis.classification}`);
  console.log(`  Severity: ${analysis.severity}`);
});
```

---

## Storage Manager

Manages storage of screenshots and diff images.

### Constructor

```typescript
class StorageManager {
  constructor(storageDir: string);
}
```

### save()

Save an image to storage.

```typescript
async save(
  testName: string,
  type: 'baseline' | 'current' | 'diff',
  buffer: Buffer
): Promise<string>;
```

**Returns:** Path to saved image

### load()

Load an image from storage.

```typescript
async load(path: string): Promise<Buffer>;
```

### cleanup()

Clean up old images.

```typescript
async cleanup(maxAge: number): Promise<number>;
```

**Returns:** Number of files deleted

---

## Error Handling

### Error Classes

**VisualTestError**

Base error class for visual testing.

```typescript
class VisualTestError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: Record<string, any>
  );
}
```

**BaselineNotFoundError**

```typescript
class BaselineNotFoundError extends VisualTestError {
  constructor(testName: string, baselinePath: string);
}
```

**ScreenshotCaptureError**

```typescript
class ScreenshotCaptureError extends VisualTestError {
  constructor(message: string, details?: Record<string, any>);
}
```

**DiffAnalysisError**

```typescript
class DiffAnalysisError extends VisualTestError {
  constructor(message: string, details?: Record<string, any>);
}
```

### Error Handling Example

```typescript
import {
  VisualTestRunner,
  BaselineNotFoundError,
  ScreenshotCaptureError
} from '@iris/visual';

try {
  const result = await runner.run();
  // Process result
} catch (error) {
  if (error instanceof BaselineNotFoundError) {
    console.error(`Baseline missing: ${error.details.testName}`);
    console.log('Run with --update-baseline to create baselines');
  } else if (error instanceof ScreenshotCaptureError) {
    console.error(`Screenshot failed: ${error.message}`);
    console.error('Details:', error.details);
  } else {
    console.error('Unknown error:', error);
  }
}
```

---

## Examples

### Complete Workflow Example

```typescript
import {
  VisualTestRunner,
  VisualDiffEngine,
  BaselineManager,
  AIVisualClassifier
} from '@iris/visual';
import { chromium } from 'playwright';

// Setup
const baselineDir = './test/baselines';
const outputDir = './test/results';

// Initialize components
const diffEngine = new VisualDiffEngine();
const baselineManager = new BaselineManager(baselineDir);
const classifier = new AIVisualClassifier({
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY
});

// Run visual regression test
const runner = new VisualTestRunner({
  pages: [
    '/',
    '/products',
    '/about',
    '/contact'
  ],
  baseline: {
    strategy: 'branch',
    reference: 'main'
  },
  capture: {
    viewport: { width: 1920, height: 1080 },
    fullPage: true,
    mask: ['.timestamp', '.dynamic-ad'],
    format: 'png',
    stabilization: {
      waitForFonts: true,
      disableAnimations: true,
      delay: 500,
      waitForNetworkIdle: true,
      networkIdleTimeout: 2000
    }
  },
  diff: {
    threshold: 0.1,
    semanticAnalysis: true,
    aiProvider: 'openai',
    antiAliasing: true,
    maxConcurrency: 3
  },
  devices: ['desktop', 'mobile', 'tablet'],
  updateBaseline: false,
  failOn: 'breaking',
  output: {
    format: 'html',
    path: `${outputDir}/visual-regression-report.html`
  }
});

const result = await runner.run();

// Process results
console.log('=== Visual Regression Test Results ===');
console.log(`Status: ${result.summary.overallStatus}`);
console.log(`Comparisons: ${result.summary.totalComparisons}`);
console.log(`Passed: ${result.summary.passed}`);
console.log(`Failed: ${result.summary.failed}`);

if (result.summary.overallStatus === 'failed') {
  console.log('\n=== Severity Breakdown ===');
  console.log(`Breaking: ${result.summary.severityCounts.breaking || 0}`);
  console.log(`Moderate: ${result.summary.severityCounts.moderate || 0}`);
  console.log(`Minor: ${result.summary.severityCounts.minor || 0}`);

  if (result.reportPath) {
    console.log(`\nDetailed report: ${result.reportPath}`);
  }

  process.exit(1);
} else {
  console.log('\n✅ All visual tests passed!');
  process.exit(0);
}
```

### Custom Comparison Example

```typescript
import { VisualDiffEngine, VisualCaptureEngine } from '@iris/visual';
import { chromium } from 'playwright';
import fs from 'fs';

const diffEngine = new VisualDiffEngine();
const captureEngine = new VisualCaptureEngine();

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1920, height: 1080 }
});

// Capture baseline
await page.goto('https://example.com');
const baselineResult = await captureEngine.capture(page, {
  fullPage: true,
  maskSelectors: ['.timestamp'],
  stabilizeMs: 500,
  disableAnimations: true,
  type: 'png'
});

fs.writeFileSync('./baseline.png', baselineResult.buffer);

// Make changes and capture again
await page.evaluate(() => {
  document.querySelector('h1').style.color = 'blue';
});

const currentResult = await captureEngine.capture(page, {
  fullPage: true,
  maskSelectors: ['.timestamp'],
  stabilizeMs: 500,
  disableAnimations: true,
  type: 'png'
});

// Compare
const diffResult = await diffEngine.compare(
  baselineResult.buffer,
  currentResult.buffer,
  {
    threshold: 0.95,
    includeAA: true,
    alpha: 0.1,
    diffMask: true,
    diffColor: [255, 0, 0]
  }
);

console.log(`Similarity: ${(diffResult.similarity * 100).toFixed(2)}%`);
console.log(`Pixels different: ${diffResult.pixelDifference}`);
console.log(`Test ${diffResult.passed ? 'passed' : 'failed'}`);

if (diffResult.diffBuffer) {
  fs.writeFileSync('./diff.png', diffResult.diffBuffer);

  // Analyze regions
  const regions = await diffEngine.analyzeRegions(
    diffResult.diffBuffer,
    1920,
    1080
  );

  console.log(`\nFound ${regions.length} difference regions:`);
  regions.forEach((region, i) => {
    console.log(`  Region ${i + 1}:`);
    console.log(`    Position: (${region.x}, ${region.y})`);
    console.log(`    Size: ${region.width}x${region.height}`);
    console.log(`    Significance: ${(region.significance * 100).toFixed(1)}%`);
  });
}

await browser.close();
```

---

## See Also

- [Visual Regression Testing Guide](../guides/visual-regression-testing.md)
- [Accessibility Testing API](./accessibility-testing.md)
- [CI/CD Integration Guide](../guides/ci-cd-integration.md)
