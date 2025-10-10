# IRIS Phase 2 Comprehensive Technical Architecture Plan
## Visual Regression & Accessibility Testing Implementation

**Document Version:** 1.0
**Date:** September 20, 2025
**Target:** Phase 2 - Enhanced Testing Implementation
**Foundation:** Phase 1 Complete (ActionExecutor, CLI, Protocol, Browser Automation)

---

## Executive Summary

This comprehensive technical architecture plan defines the implementation strategy for IRIS Phase 2, building upon the solid Phase 1 foundation to add sophisticated visual regression testing and accessibility validation capabilities. The design emphasizes modularity, testability, and seamless integration with existing Phase 1 components while incorporating industry-leading practices for visual testing and WCAG compliance.

**Key Implementation Goals:**
- Screenshot capture and intelligent baseline comparison with >95% accuracy
- AI-powered visual anomaly detection and classification
- Comprehensive WCAG 2.1 AA compliance validation with axe-core integration
- Keyboard navigation and screen reader simulation testing
- Production-ready TDD implementation with comprehensive test coverage

---

## 1. System Architecture Analysis

### 1.1 Phase 1 Foundation Assessment

Based on the current codebase analysis, Phase 1 provides an excellent foundation:

**Existing Strengths:**
- ✅ **ActionExecutor**: Robust browser lifecycle management with retry logic (243 lines)
- ✅ **CLI Framework**: Commander.js-based CLI with browser execution integration (198 lines)
- ✅ **Browser Automation**: Comprehensive Playwright wrapper with standardized controls
- ✅ **AI Integration**: Multi-provider AI client (OpenAI/Anthropic/Ollama) with 5,734+ lines
- ✅ **Database Layer**: SQLite persistence with execution result tracking (1,838+ lines)
- ✅ **Configuration System**: Environment-aware configuration management (3,423+ lines)
- ✅ **Test Coverage**: 122/122 tests passing with comprehensive module coverage

**Integration Points for Phase 2:**
```typescript
// Extension points in existing codebase
src/cli.ts          → Add visual-diff and a11y commands
src/executor.ts     → Enhance with visual assertion capabilities
src/browser.ts      → Extend with screenshot capture optimizations
src/ai-client.ts    → Add visual analysis capabilities
src/db.ts          → Schema extensions for visual and accessibility data
src/config.ts      → Visual and accessibility configuration sections
```

### 1.2 Phase 2 Module Architecture

```
src/
├── [EXISTING] Core Phase 1 modules (validated and working)
│   ├── cli.ts              ✅ 198 lines - Commander.js with browser execution
│   ├── executor.ts         ✅ 243 lines - ActionExecutor with retry logic
│   ├── browser.ts          ✅ 61 lines - Playwright wrapper
│   ├── translator.ts       ✅ 174 lines - AI-enhanced translation
│   ├── protocol.ts         ✅ 297 lines - JSON-RPC WebSocket server
│   ├── ai-client.ts        ✅ 5,734+ lines - Multi-provider AI integration
│   ├── config.ts           ✅ 3,423+ lines - Configuration management
│   ├── db.ts              ✅ 1,838+ lines - SQLite persistence
│   └── watcher.ts         ✅ 13,907+ lines - File watching with execution
│
├── visual/                 # NEW: Visual regression testing module
│   ├── index.ts           # Public API exports and module interface
│   ├── types.ts           # TypeScript interfaces and Zod schemas
│   ├── capture-engine.ts  # Screenshot capture with stabilization
│   ├── diff-engine.ts     # SSIM + pixel comparison with region analysis
│   ├── baseline-manager.ts # Git-integrated baseline storage
│   ├── ai-classifier.ts   # AI-powered semantic visual analysis
│   ├── reporter.ts        # Multi-format report generation (HTML/JSON/JUnit)
│   ├── visual-runner.ts   # Test orchestration and execution pipeline
│   └── __tests__/         # Comprehensive test suite (unit + integration)
│
├── a11y/                   # NEW: Accessibility testing module
│   ├── index.ts           # Public API exports and module interface
│   ├── types.ts           # Accessibility type definitions and schemas
│   ├── axe-runner.ts      # axe-core integration with WCAG 2.1 AA rules
│   ├── keyboard-tester.ts # Keyboard navigation and focus management
│   ├── screenreader-sim.ts # Screen reader simulation and ARIA validation
│   ├── a11y-reporter.ts   # Accessibility report generation
│   ├── a11y-runner.ts     # Accessibility test orchestration
│   └── __tests__/         # Accessibility-specific test suite
│
└── utils/                  # NEW: Shared utilities for Phase 2
    ├── image-processor.ts  # Sharp-based image processing utilities
    ├── git-integration.ts  # Git operations for baseline management
    ├── performance-monitor.ts # Performance tracking and optimization
    ├── error-handling.ts   # Enhanced error handling and recovery
    └── logger.ts          # Structured logging with correlation IDs
```

---

## 2. Core Type Definitions and Interfaces

### 2.1 Visual Testing Type System

```typescript
// src/visual/types.ts
import { z } from 'zod';

// Core Configuration Schemas
export const CaptureConfigSchema = z.object({
  viewport: z.object({
    width: z.number().min(320).max(3840),
    height: z.number().min(240).max(2160)
  }),
  fullPage: z.boolean().default(true),
  element: z.string().optional(), // CSS selector for element-specific capture
  mask: z.array(z.string()).default([]), // Dynamic content to mask
  stabilization: z.object({
    waitForFonts: z.boolean().default(true),
    disableAnimations: z.boolean().default(true),
    delay: z.number().min(0).max(5000).default(500),
    waitForNetworkIdle: z.boolean().default(true),
    networkIdleTimeout: z.number().default(2000)
  }),
  quality: z.number().min(1).max(100).default(90),
  format: z.enum(['png', 'jpeg', 'webp']).default('png'),
  devicePixelRatio: z.number().default(1)
});

export const DiffOptionsSchema = z.object({
  threshold: z.number().min(0).max(1).default(0.1),
  antiAliasing: z.boolean().default(true),
  regions: z.array(z.object({
    name: z.string(),
    selector: z.string(),
    weight: z.number().min(0).max(5).default(1)
  })).default([]),
  semanticAnalysis: z.boolean().default(false),
  aiProvider: z.enum(['openai', 'anthropic', 'ollama']).optional(),
  maxConcurrency: z.number().min(1).max(10).default(3)
});

// Runtime Types (inferred from schemas)
export type CaptureConfig = z.infer<typeof CaptureConfigSchema>;
export type DiffOptions = z.infer<typeof DiffOptionsSchema>;

// Core Data Models
export interface CaptureResult {
  id: string;
  timestamp: number;
  url: string;
  path: string;
  hash: string; // SHA-256 of image content
  metadata: {
    viewport: { width: number; height: number };
    userAgent: string;
    devicePixelRatio: number;
    colorScheme: 'light' | 'dark';
    captureMethod: 'viewport' | 'fullPage' | 'element';
    stabilizationApplied: boolean;
  };
  config: CaptureConfig;
}

export interface BaselineMetadata {
  id: string;
  branch: string;
  commit: string;
  url: string;
  element?: string;
  createdAt: number;
  updatedAt: number;
  path: string;
  hash: string;
  config: CaptureConfig;
  version: string; // Baseline format version for migration compatibility
}

export interface DiffResult {
  id: string;
  baselineId: string;
  candidateId: string;
  timestamp: number;
  pixelDiff: {
    totalPixels: number;
    diffPixels: number;
    percentage: number;
    ssim: number; // Structural Similarity Index (0-1)
    psnr?: number; // Peak Signal-to-Noise Ratio (optional)
  };
  regions: RegionDiff[];
  semanticAnalysis?: {
    confidence: number;
    classification: 'intentional' | 'unintentional' | 'unknown';
    changeType: 'layout' | 'color' | 'content' | 'typography' | 'mixed';
    reasoning: string;
    aiProvider: string;
    processingTime: number;
  };
  overall: {
    severity: 'none' | 'minor' | 'moderate' | 'breaking';
    pass: boolean;
    score: number; // Composite score (0-1, higher = more similar)
    confidence: number;
  };
  artifacts: {
    diffImage: string;
    overlayImage: string;
    heatmap: string;
    metadata: string; // JSON file with detailed analysis
  };
  processingTime: number;
}

export interface RegionDiff {
  id: string;
  name: string;
  selector: string;
  diffPercentage: number;
  severity: 'none' | 'minor' | 'moderate' | 'breaking';
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  changeType?: string;
  pixelCount: number;
  weight: number; // Region importance weight
}

export interface VisualTestRun {
  id: string;
  timestamp: number;
  pages: string[];
  baseline: {
    strategy: 'branch' | 'commit' | 'manual';
    reference: string;
  };
  results: DiffResult[];
  summary: {
    totalPages: number;
    totalComparisons: number;
    passed: number;
    failed: number;
    severityCounts: Record<string, number>;
    overallStatus: 'passed' | 'failed';
    processingTime: number;
  };
  config: {
    capture: CaptureConfig;
    diff: DiffOptions;
  };
  environment: {
    os: string;
    browser: string;
    browserVersion: string;
    irisVersion: string;
  };
}
```

### 2.2 Accessibility Testing Type System

```typescript
// src/a11y/types.ts
import { z } from 'zod';

// Accessibility Configuration
export const AccessibilityConfigSchema = z.object({
  axe: z.object({
    rules: z.record(z.object({ enabled: z.boolean() })).default({}),
    tags: z.array(z.string()).default(['wcag2a', 'wcag2aa', 'wcag21aa']),
    include: z.array(z.string()).default([]),
    exclude: z.array(z.string()).default([]),
    disableRules: z.array(z.string()).default([]),
    timeout: z.number().default(30000)
  }),
  keyboard: z.object({
    testFocusOrder: z.boolean().default(true),
    testTrapDetection: z.boolean().default(true),
    testArrowKeyNavigation: z.boolean().default(true),
    testEscapeHandling: z.boolean().default(true),
    customSequences: z.array(z.object({
      name: z.string(),
      keys: z.array(z.string()),
      expectedOutcome: z.string(),
      startSelector: z.string().optional()
    })).default([])
  }),
  screenReader: z.object({
    testAriaLabels: z.boolean().default(true),
    testLandmarkNavigation: z.boolean().default(true),
    testImageAltText: z.boolean().default(true),
    testHeadingStructure: z.boolean().default(true),
    simulateScreenReader: z.boolean().default(false)
  }),
  failureThreshold: z.object({
    critical: z.boolean().default(true),
    serious: z.boolean().default(true),
    moderate: z.boolean().default(false),
    minor: z.boolean().default(false)
  }),
  reporting: z.object({
    includePassedTests: z.boolean().default(false),
    groupByImpact: z.boolean().default(true),
    includeScreenshots: z.boolean().default(true)
  })
});

export type AccessibilityConfig = z.infer<typeof AccessibilityConfigSchema>;

// Core Accessibility Interfaces
export interface AccessibilityTestRun {
  id: string;
  timestamp: number;
  url: string;
  results: {
    axe: AxeTestResult;
    keyboard: KeyboardTestResult;
    screenReader: ScreenReaderTestResult;
  };
  summary: {
    totalViolations: number;
    violationsBySeverity: Record<string, number>;
    passed: boolean;
    score: number; // Accessibility score (0-100)
    completionTime: number;
  };
  config: AccessibilityConfig;
  environment: {
    userAgent: string;
    viewport: { width: number; height: number };
    colorScheme: 'light' | 'dark';
  };
}

export interface AxeTestResult {
  violations: AxeViolation[];
  passes: AxeCheckResult[];
  incomplete: AxeCheckResult[];
  inapplicable: AxeCheckResult[];
  timestamp: number;
  url: string;
  testEngine: {
    name: string;
    version: string;
  };
}

export interface AxeViolation {
  id: string;
  impact: 'critical' | 'serious' | 'moderate' | 'minor';
  description: string;
  help: string;
  helpUrl: string;
  tags: string[];
  nodes: Array<{
    target: string[];
    html: string;
    failureSummary: string;
    impact: string;
    any: AxeCheckResult[];
    all: AxeCheckResult[];
    none: AxeCheckResult[];
  }>;
}

export interface AxeCheckResult {
  id: string;
  description: string;
  impact?: string;
  message?: string;
  data?: any;
  relatedNodes?: Array<{
    target: string[];
    html: string;
  }>;
}

export interface KeyboardTestResult {
  focusOrder: {
    valid: boolean;
    sequence: Array<{
      element: string;
      tabIndex: number;
      visible: boolean;
      focusable: boolean;
    }>;
    issues: Array<{
      element: string;
      issue: 'unreachable' | 'wrong-order' | 'focus-trap' | 'missing-outline' | 'invisible-focus';
      description: string;
      severity: 'error' | 'warning';
    }>;
  };
  navigation: {
    tabTraversal: {
      tested: boolean;
      passed: boolean;
      elementsReached: number;
      totalFocusable: number;
    };
    arrowKeySupport: {
      tested: boolean;
      passed: boolean;
      components: string[];
    };
    escapeKeySupport: {
      tested: boolean;
      passed: boolean;
      modalsHandled: number;
    };
    enterKeySupport: {
      tested: boolean;
      passed: boolean;
      buttonsActivated: number;
    };
  };
  customSequences: Array<{
    name: string;
    passed: boolean;
    actualOutcome: string;
    expectedOutcome: string;
  }>;
}

export interface ScreenReaderTestResult {
  ariaLabels: {
    coverage: number; // Percentage of interactive elements with labels
    missing: Array<{
      selector: string;
      element: string;
      suggestedLabel?: string;
    }>;
    present: Array<{
      selector: string;
      label: string;
      labelSource: 'aria-label' | 'aria-labelledby' | 'title' | 'alt';
    }>;
  };
  landmarks: {
    present: boolean;
    structure: Array<{
      type: string;
      label?: string;
      selector: string;
      level?: number; // For headings
    }>;
    issues: Array<{
      type: 'missing-main' | 'multiple-main' | 'unlabeled-region' | 'poor-heading-structure';
      description: string;
      severity: 'error' | 'warning';
    }>;
  };
  imageAltText: {
    coverage: number; // Percentage of images with appropriate alt text
    missing: Array<{
      selector: string;
      src: string;
      context?: string;
    }>;
    decorative: Array<{
      selector: string;
      src: string;
      markedDecorative: boolean;
    }>;
  };
  headingStructure: {
    valid: boolean;
    hierarchy: Array<{
      level: number;
      text: string;
      selector: string;
    }>;
    issues: Array<{
      type: 'missing-h1' | 'skipped-level' | 'empty-heading';
      description: string;
      element?: string;
    }>;
  };
}
```

---

## 3. Technology Stack and Dependencies

### 3.1 Visual Processing Dependencies

```json
{
  "dependencies": {
    // Image Processing
    "sharp": "^0.32.6",              // High-performance image processing
    "image-ssim": "^0.2.0",         // Structural similarity comparison
    "pixelmatch": "^5.3.0",         // Pixel-level difference detection
    "pngjs": "^7.0.0",              // PNG image manipulation

    // Git Integration
    "simple-git": "^3.19.1",        // Git operations for baseline management
    "node-git-server": "^0.6.1",    // Optional git server for baseline sharing

    // AI/ML Libraries
    "openai": "^4.0.0",             // Already present in Phase 1
    "@anthropic-ai/sdk": "^0.6.0",  // Claude integration
    "ollama": "^0.5.0",             // Local AI model support

    // Performance and Utilities
    "lru-cache": "^10.0.1",         // Caching for AI results and baselines
    "p-limit": "^4.0.0",            // Concurrency control
    "p-queue": "^7.0.0",            // Advanced queuing for AI requests
    "xxhash-wasm": "^1.0.2"         // Fast hashing for image deduplication
  },
  "devDependencies": {
    // Testing
    "@types/sharp": "^0.32.0",
    "@types/pixelmatch": "^5.2.4",
    "@types/pngjs": "^6.0.1"
  }
}
```

### 3.2 Accessibility Testing Dependencies

```json
{
  "dependencies": {
    // Accessibility Testing
    "@axe-core/playwright": "^4.8.2",  // Official axe-core Playwright integration
    "axe-core": "^4.8.2",              // Core accessibility rules engine
    "accessibility-checker": "^3.1.67", // IBM accessibility checker (backup)
    "aria-query": "^5.3.0",            // ARIA specification queries
    "color-contrast-checker": "^2.1.0", // Color contrast validation

    // Screen Reader Simulation
    "virtual-screen-reader": "^0.7.0", // Screen reader simulation
    "aria-live-regions": "^1.0.0",     // ARIA live region testing

    // Keyboard Navigation
    "focus-trap": "^7.5.4",           // Focus trap detection and validation
    "tabbable": "^6.2.0"              // Tabbable element detection
  }
}
```

### 3.3 Integration with Existing Phase 1 Stack

The Phase 2 implementation will leverage and extend the existing Phase 1 dependencies:

```typescript
// Extending existing AI client capabilities
// src/ai-client.ts (extend existing implementation)
export interface VisualAnalysisCapability {
  analyzeVisualChange(
    baselineImage: Buffer,
    candidateImage: Buffer,
    context?: {
      url: string;
      pageType?: string;
      userStory?: string;
      expectedChanges?: string[];
    }
  ): Promise<{
    classification: 'intentional' | 'unintentional' | 'unknown';
    confidence: number;
    reasoning: string;
    changeType: 'layout' | 'color' | 'content' | 'typography' | 'mixed';
    severity: 'none' | 'minor' | 'moderate' | 'breaking';
  }>;
}

// Extend existing OpenAIClient, AnthropicClient, and OllamaClient classes
```

---

## 4. Test-Driven Development Strategy

### 4.1 Test Architecture Overview

```
Testing Pyramid for Phase 2:
                     ┌─────────────────┐
                     │  System Tests   │  ← Full workflow end-to-end
                     │   (8-12 tests)  │
                     └─────────────────┘
                           ┌─────────────────────┐
                           │ Integration Tests   │  ← Module interaction
                           │   (25-35 tests)     │
                           └─────────────────────┘
                                 ┌─────────────────────────┐
                                 │    Unit Tests           │  ← Component isolation
                                 │   (120+ tests)          │
                                 └─────────────────────────┘
```

### 4.2 Component-Specific Test Strategies

**Visual Capture Engine Testing:**
```typescript
// src/visual/__tests__/capture-engine.test.ts
import { VisualCaptureEngine } from '../capture-engine';
import { chromium } from 'playwright';

describe('VisualCaptureEngine', () => {
  let browser: Browser;
  let page: Page;
  let captureEngine: VisualCaptureEngine;

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
    captureEngine = new VisualCaptureEngine();
  });

  describe('screenshot capture', () => {
    it('should capture viewport screenshot with default config', async () => {
      await page.goto('data:text/html,<div style="width:100vw;height:100vh;background:red;">Test</div>');

      const config: CaptureConfig = {
        viewport: { width: 1920, height: 1080 },
        fullPage: false,
        format: 'png',
        quality: 90,
        stabilization: {
          waitForFonts: true,
          disableAnimations: true,
          delay: 0,
          waitForNetworkIdle: false,
          networkIdleTimeout: 0
        }
      };

      const result = await captureEngine.capture(page, 'http://test.local', config);

      expect(result.path).toMatch(/\.png$/);
      expect(result.hash).toHaveLength(64); // SHA-256
      expect(result.metadata.viewport).toEqual({ width: 1920, height: 1080 });
      expect(await fs.pathExists(result.path)).toBe(true);
    });

    it('should handle element masking correctly', async () => {
      await page.setContent(`
        <div class="content">Static content</div>
        <div class="timestamp">${Date.now()}</div>
        <div class="ad">Advertisement</div>
      `);

      const config: CaptureConfig = {
        viewport: { width: 800, height: 600 },
        fullPage: true,
        mask: ['.timestamp', '.ad'],
        format: 'png',
        quality: 90,
        stabilization: { /* default */ }
      };

      const result1 = await captureEngine.capture(page, 'http://test.local', config);

      // Change dynamic content
      await page.evaluate(() => {
        const timestamp = document.querySelector('.timestamp');
        const ad = document.querySelector('.ad');
        if (timestamp) timestamp.textContent = 'Different timestamp';
        if (ad) ad.textContent = 'Different ad content';
      });

      const result2 = await captureEngine.capture(page, 'http://test.local', config);

      // Masked screenshots should be identical despite content changes
      expect(result1.hash).toBe(result2.hash);
    });

    it('should stabilize page before capture', async () => {
      await page.setContent(`
        <div id="content">Loading...</div>
        <script>
          setTimeout(() => {
            document.getElementById('content').textContent = 'Loaded!';
          }, 100);
        </script>
      `);

      const config: CaptureConfig = {
        viewport: { width: 800, height: 600 },
        fullPage: false,
        format: 'png',
        quality: 90,
        stabilization: {
          waitForFonts: true,
          disableAnimations: true,
          delay: 200,
          waitForNetworkIdle: false,
          networkIdleTimeout: 0
        }
      };

      const result = await captureEngine.capture(page, 'http://test.local', config);

      // Verify the page was stabilized (content should be "Loaded!")
      const buffer = await fs.readFile(result.path);
      // Additional verification could include OCR or pixel analysis
      expect(buffer.length).toBeGreaterThan(1000); // Basic sanity check
    });
  });
});
```

**Visual Diff Engine Testing:**
```typescript
// src/visual/__tests__/diff-engine.test.ts
import { VisualDiffEngine } from '../diff-engine';
import { createTestImage, loadFixtureImage } from './fixtures/image-helpers';

describe('VisualDiffEngine', () => {
  let diffEngine: VisualDiffEngine;

  beforeEach(() => {
    diffEngine = new VisualDiffEngine();
  });

  describe('pixel comparison', () => {
    it('should detect no differences for identical images', async () => {
      const baseline = await loadFixtureImage('baseline.png');
      const candidate = baseline; // Same image

      const options: DiffOptions = {
        threshold: 0.1,
        antiAliasing: true,
        regions: [],
        semanticAnalysis: false,
        maxConcurrency: 1
      };

      const result = await diffEngine.compare(baseline, candidate, options);

      expect(result.pixelDiff.percentage).toBe(0);
      expect(result.pixelDiff.ssim).toBe(1);
      expect(result.overall.severity).toBe('none');
      expect(result.overall.pass).toBe(true);
      expect(result.overall.score).toBe(1);
    });

    it('should detect minor text changes', async () => {
      const baseline = await loadFixtureImage('text-baseline.png');
      const candidate = await loadFixtureImage('text-minor-change.png'); // Small text difference

      const options: DiffOptions = {
        threshold: 0.05,
        antiAliasing: true,
        regions: [],
        semanticAnalysis: false,
        maxConcurrency: 1
      };

      const result = await diffEngine.compare(baseline, candidate, options);

      expect(result.pixelDiff.percentage).toBeGreaterThan(0);
      expect(result.pixelDiff.percentage).toBeLessThan(0.1);
      expect(result.overall.severity).toBe('minor');
      expect(result.overall.pass).toBe(true); // Minor changes should pass
    });

    it('should detect breaking layout changes', async () => {
      const baseline = await loadFixtureImage('layout-baseline.png');
      const candidate = await loadFixtureImage('layout-broken.png'); // Major layout shift

      const options: DiffOptions = {
        threshold: 0.1,
        antiAliasing: true,
        regions: [
          { name: 'header', selector: 'header', weight: 2 },
          { name: 'nav', selector: 'nav', weight: 1.5 }
        ],
        semanticAnalysis: false,
        maxConcurrency: 1
      };

      const result = await diffEngine.compare(baseline, candidate, options);

      expect(result.pixelDiff.percentage).toBeGreaterThan(0.15);
      expect(result.overall.severity).toBe('breaking');
      expect(result.overall.pass).toBe(false);
      expect(result.regions.length).toBeGreaterThan(0);
    });
  });

  describe('AI semantic analysis', () => {
    it('should classify intentional design changes correctly', async () => {
      const baseline = await loadFixtureImage('old-design.png');
      const candidate = await loadFixtureImage('new-design.png'); // Intentional redesign

      const options: DiffOptions = {
        threshold: 0.1,
        antiAliasing: true,
        regions: [],
        semanticAnalysis: true,
        aiProvider: 'openai',
        maxConcurrency: 1
      };

      // Mock AI response for deterministic testing
      const mockAIResponse = {
        classification: 'intentional' as const,
        confidence: 0.85,
        reasoning: 'Color scheme update and typography changes appear intentional',
        changeType: 'color' as const,
        severity: 'moderate' as const
      };

      jest.spyOn(diffEngine['aiClassifier'], 'analyzeVisualChange')
        .mockResolvedValue(mockAIResponse);

      const result = await diffEngine.compare(baseline, candidate, options);

      expect(result.semanticAnalysis?.classification).toBe('intentional');
      expect(result.semanticAnalysis?.confidence).toBeGreaterThan(0.8);
      expect(result.overall.severity).toBe('moderate'); // Intentional changes can be moderate
    });
  });
});
```

**Baseline Manager Testing:**
```typescript
// src/visual/__tests__/baseline-manager.test.ts
import { BaselineManager } from '../baseline-manager';
import { createTempGitRepo, createTestCapture } from './fixtures/git-helpers';

describe('BaselineManager', () => {
  let tempRepoPath: string;
  let baselineManager: BaselineManager;

  beforeEach(async () => {
    tempRepoPath = await createTempGitRepo();
    baselineManager = new BaselineManager(tempRepoPath);
  });

  afterEach(async () => {
    await fs.remove(tempRepoPath);
  });

  describe('baseline storage and retrieval', () => {
    it('should store and retrieve baselines by branch', async () => {
      const capture = await createTestCapture('http://example.com', 'main');

      const baseline = await baselineManager.setBaseline(capture, {
        branch: 'main',
        commit: 'abc123',
        url: 'http://example.com'
      });

      expect(baseline.id).toBeDefined();
      expect(baseline.branch).toBe('main');
      expect(baseline.path).toContain('.iris/baselines/main/');

      const retrieved = await baselineManager.getBaseline('http://example.com', undefined, {
        type: 'branch',
        reference: 'main'
      });

      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(baseline.id);
      expect(retrieved!.hash).toBe(capture.hash);
    });

    it('should handle branch isolation correctly', async () => {
      // Create baseline on main branch
      const mainCapture = await createTestCapture('http://example.com', 'main');
      await baselineManager.setBaseline(mainCapture, {
        branch: 'main',
        commit: 'abc123',
        url: 'http://example.com'
      });

      // Switch to feature branch
      await baselineManager.switchBranch('feature/new-ui');

      // Feature branch should not have baseline initially
      const featureBaseline = await baselineManager.getBaseline('http://example.com', undefined, {
        type: 'branch',
        reference: 'feature/new-ui'
      });

      expect(featureBaseline).toBeNull();

      // Can still access main branch baseline explicitly
      const mainBaseline = await baselineManager.getBaseline('http://example.com', undefined, {
        type: 'branch',
        reference: 'main'
      });

      expect(mainBaseline).not.toBeNull();
    });
  });

  describe('baseline cleanup', () => {
    it('should clean up old baselines based on retention policy', async () => {
      const oldDate = Date.now() - (40 * 24 * 60 * 60 * 1000); // 40 days ago
      const recentDate = Date.now() - (10 * 24 * 60 * 60 * 1000); // 10 days ago

      // Create old baseline
      const oldCapture = await createTestCapture('http://example.com/old', 'main');
      const oldBaseline = await baselineManager.setBaseline(oldCapture, {
        branch: 'main',
        commit: 'old123',
        url: 'http://example.com/old'
      });

      // Manually update timestamp to simulate old baseline
      await baselineManager.updateBaselineTimestamp(oldBaseline.id, oldDate);

      // Create recent baseline
      const recentCapture = await createTestCapture('http://example.com/recent', 'main');
      await baselineManager.setBaseline(recentCapture, {
        branch: 'main',
        commit: 'recent123',
        url: 'http://example.com/recent'
      });

      // Clean up baselines older than 30 days
      const cleanedCount = await baselineManager.cleanupOldBaselines(30);

      expect(cleanedCount).toBe(1);

      // Old baseline should be removed
      const oldRetrieved = await baselineManager.getBaseline('http://example.com/old');
      expect(oldRetrieved).toBeNull();

      // Recent baseline should remain
      const recentRetrieved = await baselineManager.getBaseline('http://example.com/recent');
      expect(recentRetrieved).not.toBeNull();
    });
  });
});
```

**Accessibility Testing:**
```typescript
// src/a11y/__tests__/axe-runner.test.ts
import { AxeRunner } from '../axe-runner';
import { chromium } from 'playwright';

describe('AxeRunner', () => {
  let browser: Browser;
  let page: Page;
  let axeRunner: AxeRunner;

  beforeAll(async () => {
    browser = await chromium.launch();
    axeRunner = new AxeRunner();
  });

  beforeEach(async () => {
    page = await browser.newPage();
  });

  describe('WCAG compliance testing', () => {
    it('should pass for accessible content', async () => {
      await page.setContent(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <title>Accessible Page</title>
        </head>
        <body>
          <main>
            <h1>Main Heading</h1>
            <button aria-label="Close dialog">×</button>
            <img src="test.jpg" alt="Descriptive text">
            <label for="email">Email:</label>
            <input type="email" id="email" required>
          </main>
        </body>
        </html>
      `);

      const config: AccessibilityConfig = {
        axe: {
          tags: ['wcag2a', 'wcag2aa'],
          rules: {},
          include: [],
          exclude: [],
          disableRules: [],
          timeout: 30000
        },
        keyboard: { /* default values */ },
        screenReader: { /* default values */ },
        failureThreshold: {
          critical: true,
          serious: true,
          moderate: false,
          minor: false
        },
        reporting: { /* default values */ }
      };

      const result = await axeRunner.runAccessibilityTest(page, 'http://test.local', config);

      expect(result.results.axe.violations.filter(v => v.impact === 'critical')).toHaveLength(0);
      expect(result.results.axe.violations.filter(v => v.impact === 'serious')).toHaveLength(0);
      expect(result.summary.passed).toBe(true);
      expect(result.summary.score).toBeGreaterThan(95);
    });

    it('should detect accessibility violations', async () => {
      await page.setContent(`
        <!DOCTYPE html>
        <html>
        <body>
          <div>No heading structure</div>
          <button>Unlabeled button</button>
          <img src="test.jpg">
          <input type="text" placeholder="Email">
          <div style="color: #ccc; background: #ddd;">Low contrast text</div>
        </body>
        </html>
      `);

      const config: AccessibilityConfig = {
        axe: {
          tags: ['wcag2a', 'wcag2aa'],
          rules: {},
          include: [],
          exclude: [],
          disableRules: [],
          timeout: 30000
        },
        keyboard: { /* default values */ },
        screenReader: { /* default values */ },
        failureThreshold: {
          critical: true,
          serious: true,
          moderate: true,
          minor: true
        },
        reporting: { /* default values */ }
      };

      const result = await axeRunner.runAccessibilityTest(page, 'http://test.local', config);

      expect(result.results.axe.violations.length).toBeGreaterThan(0);
      expect(result.summary.passed).toBe(false);

      // Check for specific violations
      const violationIds = result.results.axe.violations.map(v => v.id);
      expect(violationIds).toContain('image-alt'); // Missing alt text
      expect(violationIds).toContain('label'); // Missing form labels
      expect(violationIds).toContain('color-contrast'); // Poor contrast
    });
  });
});
```

### 4.3 Integration Testing Strategy

**CLI Integration Tests:**
```typescript
// src/__tests__/integration/cli-visual.test.ts
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

describe('CLI Visual Commands Integration', () => {
  it('should execute visual-diff command end-to-end', async () => {
    // Setup test server with known content
    const testServer = await startTestServer();

    try {
      const { stdout, stderr } = await execAsync(
        `npm start visual-diff --pages="http://localhost:${testServer.port}/" --baseline=test-baseline --format=json`
      );

      expect(stderr).toBe('');

      const result = JSON.parse(stdout);
      expect(result.summary.totalPages).toBe(1);
      expect(result.summary.overallStatus).toMatch(/passed|failed/);

      // Verify artifacts were created
      expect(await fs.pathExists('.iris/visual-reports')).toBe(true);
      expect(await fs.pathExists('.iris/baselines')).toBe(true);
    } finally {
      await testServer.close();
    }
  });

  it('should handle accessibility testing integration', async () => {
    const testServer = await startTestServer();

    try {
      const { stdout } = await execAsync(
        `npm start a11y --pages="http://localhost:${testServer.port}/" --fail-on=serious,critical --format=json`
      );

      const result = JSON.parse(stdout);
      expect(result.summary.totalViolations).toBeDefined();
      expect(result.summary.score).toBeGreaterThanOrEqual(0);
      expect(result.summary.score).toBeLessThanOrEqual(100);
    } finally {
      await testServer.close();
    }
  });
});
```

---

## 5. Database Schema Migration Strategy

### 5.1 Phase 2 Schema Extensions

```sql
-- Migration 002: Phase 2 Visual Testing Schema
-- File: src/db/migrations/002-phase2-visual.sql

BEGIN TRANSACTION;

-- Visual baselines table
CREATE TABLE IF NOT EXISTS visual_baselines (
  id TEXT PRIMARY KEY,
  branch TEXT NOT NULL,
  commit TEXT NOT NULL,
  url TEXT NOT NULL,
  element TEXT,                    -- CSS selector for element-specific baselines
  device TEXT,                     -- Device type (desktop, mobile, tablet)
  path TEXT NOT NULL,              -- File path to baseline image
  hash TEXT NOT NULL,              -- SHA-256 hash of baseline image
  config_json TEXT NOT NULL,       -- Serialized CaptureConfig
  metadata_json TEXT,              -- Additional metadata
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version TEXT DEFAULT '2.0',      -- Baseline format version

  UNIQUE(branch, url, element, device)
);

-- Visual comparisons table (extends existing visual_diffs)
CREATE TABLE IF NOT EXISTS visual_comparisons (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  baseline_id TEXT,
  candidate_path TEXT NOT NULL,
  candidate_hash TEXT NOT NULL,
  diff_result_json TEXT NOT NULL,  -- Serialized DiffResult
  artifacts_json TEXT,             -- Paths to generated artifacts
  processing_time INTEGER,         -- Processing time in milliseconds
  ai_analysis_json TEXT,           -- AI semantic analysis results
  created_at INTEGER NOT NULL,

  FOREIGN KEY(run_id) REFERENCES test_runs(id) ON DELETE CASCADE,
  FOREIGN KEY(baseline_id) REFERENCES visual_baselines(id) ON DELETE SET NULL
);

-- Region-specific diff results
CREATE TABLE IF NOT EXISTS region_diffs (
  id TEXT PRIMARY KEY,
  comparison_id TEXT NOT NULL,
  name TEXT NOT NULL,              -- Region name (header, footer, etc.)
  selector TEXT NOT NULL,          -- CSS selector for region
  diff_percentage REAL NOT NULL,
  severity TEXT NOT NULL,          -- none, minor, moderate, breaking
  bounding_box_json TEXT,          -- Serialized bounding box coordinates
  weight REAL DEFAULT 1.0,         -- Region importance weight
  change_type TEXT,                -- layout, color, content, typography

  FOREIGN KEY(comparison_id) REFERENCES visual_comparisons(id) ON DELETE CASCADE
);

-- Accessibility test results
CREATE TABLE IF NOT EXISTS accessibility_results (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  url TEXT NOT NULL,
  axe_results_json TEXT NOT NULL,
  keyboard_results_json TEXT,
  screenreader_results_json TEXT,
  summary_json TEXT NOT NULL,
  config_json TEXT,
  processing_time INTEGER,
  created_at INTEGER NOT NULL,

  FOREIGN KEY(run_id) REFERENCES test_runs(id) ON DELETE CASCADE
);

-- Accessibility violations (for easier querying)
CREATE TABLE IF NOT EXISTS accessibility_violations (
  id TEXT PRIMARY KEY,
  result_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  impact TEXT NOT NULL,           -- critical, serious, moderate, minor
  description TEXT NOT NULL,
  help_url TEXT,
  node_selector TEXT,
  node_html TEXT,
  failure_summary TEXT,

  FOREIGN KEY(result_id) REFERENCES accessibility_results(id) ON DELETE CASCADE
);

-- Extend existing test_runs table
ALTER TABLE test_runs ADD COLUMN visual_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE test_runs ADD COLUMN a11y_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE test_runs ADD COLUMN baseline_reference TEXT;
ALTER TABLE test_runs ADD COLUMN environment_json TEXT;

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_visual_baselines_branch_url ON visual_baselines(branch, url);
CREATE INDEX IF NOT EXISTS idx_visual_baselines_hash ON visual_baselines(hash);
CREATE INDEX IF NOT EXISTS idx_visual_comparisons_run_id ON visual_comparisons(run_id);
CREATE INDEX IF NOT EXISTS idx_visual_comparisons_baseline_id ON visual_comparisons(baseline_id);
CREATE INDEX IF NOT EXISTS idx_region_diffs_comparison_id ON region_diffs(comparison_id);
CREATE INDEX IF NOT EXISTS idx_accessibility_results_run_id ON accessibility_results(run_id);
CREATE INDEX IF NOT EXISTS idx_accessibility_violations_result_id ON accessibility_violations(result_id);
CREATE INDEX IF NOT EXISTS idx_accessibility_violations_impact ON accessibility_violations(impact);

-- Update schema version
INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES ('002', strftime('%s', 'now'));

COMMIT;
```

### 5.2 Migration Implementation

```typescript
// src/db/migrator.ts
import { Database } from 'better-sqlite3';
import * as fs from 'fs-extra';
import * as path from 'path';

export class DatabaseMigrator {
  constructor(private db: Database) {}

  async migrate(): Promise<void> {
    await this.ensureSchemaVersionTable();

    const currentVersion = await this.getCurrentVersion();
    const availableMigrations = await this.getAvailableMigrations();

    const pendingMigrations = availableMigrations.filter(
      migration => migration.version > currentVersion
    );

    for (const migration of pendingMigrations) {
      console.log(`Applying migration ${migration.version}: ${migration.description}`);
      await this.applyMigration(migration);
    }
  }

  private async ensureSchemaVersionTable(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version TEXT PRIMARY KEY,
        description TEXT,
        applied_at INTEGER NOT NULL
      );
    `);
  }

  private async getCurrentVersion(): Promise<string> {
    const result = this.db.prepare(`
      SELECT version FROM schema_version ORDER BY version DESC LIMIT 1
    `).get() as { version: string } | undefined;

    return result?.version || '000';
  }

  private async getAvailableMigrations(): Promise<Migration[]> {
    const migrationsDir = path.join(__dirname, 'migrations');
    const files = await fs.readdir(migrationsDir);

    return files
      .filter(file => file.endsWith('.sql'))
      .map(file => {
        const version = file.substring(0, 3);
        const description = file.substring(4, file.length - 4).replace(/-/g, ' ');
        return {
          version,
          description,
          path: path.join(migrationsDir, file)
        };
      })
      .sort((a, b) => a.version.localeCompare(b.version));
  }

  private async applyMigration(migration: Migration): Promise<void> {
    const sql = await fs.readFile(migration.path, 'utf-8');

    try {
      this.db.exec(sql);

      this.db.prepare(`
        INSERT INTO schema_version (version, description, applied_at)
        VALUES (?, ?, ?)
      `).run(migration.version, migration.description, Date.now());

      console.log(`✅ Migration ${migration.version} applied successfully`);
    } catch (error) {
      console.error(`❌ Migration ${migration.version} failed:`, error);
      throw error;
    }
  }
}

interface Migration {
  version: string;
  description: string;
  path: string;
}
```

---

## 6. CLI Integration and Command Implementation

### 6.1 Visual Diff Command Implementation

```typescript
// src/cli.ts (extend existing file)
import { VisualTestRunner } from './visual/visual-runner';
import { AccessibilityRunner } from './a11y/a11y-runner';

// Add new commands to existing CLI structure
program
  .command('visual-diff')
  .description('Run visual regression testing')
  .option('--pages <patterns>', 'Page patterns to test (comma-separated)', '/')
  .option('--baseline <reference>', 'Baseline branch or commit', 'main')
  .option('--semantic', 'Enable AI-powered semantic analysis', false)
  .option('--threshold <value>', 'Pixel difference threshold (0-1)', '0.1')
  .option('--devices <list>', 'Device types (desktop,mobile,tablet)', 'desktop')
  .option('--format <type>', 'Output format (html|json|junit)', 'html')
  .option('--output <path>', 'Output file path')
  .option('--fail-on <severity>', 'Fail on severity level (minor|moderate|breaking)', 'breaking')
  .option('--update-baseline', 'Update baseline with current screenshots', false)
  .option('--mask <selectors>', 'CSS selectors to mask (comma-separated)')
  .option('--exclude <selectors>', 'CSS selectors to exclude (comma-separated)')
  .option('--concurrency <number>', 'Max concurrent comparisons', '3')
  .action(async (options) => {
    const startTime = Date.now();

    try {
      console.log('🎯 Starting visual regression testing...');

      const runner = new VisualTestRunner({
        pages: options.pages.split(',').map((p: string) => p.trim()),
        baseline: {
          strategy: 'branch' as const,
          reference: options.baseline
        },
        capture: {
          viewport: { width: 1920, height: 1080 },
          fullPage: true,
          mask: options.mask ? options.mask.split(',').map((s: string) => s.trim()) : [],
          format: 'png' as const,
          quality: 90,
          stabilization: {
            waitForFonts: true,
            disableAnimations: true,
            delay: 500,
            waitForNetworkIdle: true,
            networkIdleTimeout: 2000
          }
        },
        diff: {
          threshold: parseFloat(options.threshold),
          semanticAnalysis: options.semantic,
          aiProvider: 'openai' as const,
          antiAliasing: true,
          regions: [],
          maxConcurrency: parseInt(options.concurrency)
        },
        devices: options.devices.split(',').map((d: string) => d.trim()),
        updateBaseline: options.updateBaseline,
        failOn: options.failOn,
        output: {
          format: options.format,
          path: options.output
        }
      });

      const result = await runner.run();

      const duration = Date.now() - startTime;
      console.log(`\n📊 Visual testing completed in ${duration}ms`);
      console.log(`   Total comparisons: ${result.summary.totalComparisons}`);
      console.log(`   Passed: ${result.summary.passed}`);
      console.log(`   Failed: ${result.summary.failed}`);

      if (result.summary.overallStatus === 'failed') {
        console.log(`\n❌ Visual regression detected!`);
        console.log(`   Breaking: ${result.summary.severityCounts.breaking || 0}`);
        console.log(`   Moderate: ${result.summary.severityCounts.moderate || 0}`);
        console.log(`   Minor: ${result.summary.severityCounts.minor || 0}`);

        if (options.format === 'html' && result.reportPath) {
          console.log(`\n📋 Report generated: ${result.reportPath}`);
        }

        // Exit with failure code based on severity threshold
        const failureSeverities = ['breaking', 'moderate', 'minor'];
        const failIndex = failureSeverities.indexOf(options.failOn);
        const hasFailures = failureSeverities.slice(0, failIndex + 1)
          .some(severity => (result.summary.severityCounts[severity] || 0) > 0);

        if (hasFailures) {
          process.exit(5); // Visual regression failure exit code
        }
      } else {
        console.log(`\n✅ All visual tests passed!`);
      }

    } catch (error) {
      console.error(`\n❌ Visual testing failed:`, error);
      process.exit(3); // Environment/runtime error
    }
  });

program
  .command('a11y')
  .description('Run accessibility testing')
  .option('--pages <patterns>', 'Page patterns to test (comma-separated)', '/')
  .option('--rules <rules>', 'Specific axe rules to run (comma-separated)')
  .option('--tags <tags>', 'Axe rule tags (wcag2a,wcag2aa,wcag21aa)', 'wcag2a,wcag2aa')
  .option('--fail-on <impacts>', 'Fail on impact levels (critical,serious,moderate,minor)', 'critical,serious')
  .option('--format <type>', 'Output format (html|json|junit)', 'html')
  .option('--output <path>', 'Output file path')
  .option('--include-keyboard', 'Include keyboard navigation testing', true)
  .option('--include-screenreader', 'Include screen reader simulation', false)
  .action(async (options) => {
    const startTime = Date.now();

    try {
      console.log('♿ Starting accessibility testing...');

      const runner = new AccessibilityRunner({
        pages: options.pages.split(',').map((p: string) => p.trim()),
        axe: {
          rules: {},
          tags: options.tags.split(',').map((t: string) => t.trim()),
          include: [],
          exclude: [],
          disableRules: [],
          timeout: 30000
        },
        keyboard: {
          testFocusOrder: options.includeKeyboard,
          testTrapDetection: options.includeKeyboard,
          testArrowKeyNavigation: options.includeKeyboard,
          testEscapeHandling: options.includeKeyboard,
          customSequences: []
        },
        screenReader: {
          testAriaLabels: options.includeScreenreader,
          testLandmarkNavigation: options.includeScreenreader,
          testImageAltText: options.includeScreenreader,
          testHeadingStructure: options.includeScreenreader,
          simulateScreenReader: options.includeScreenreader
        },
        failureThreshold: options.failOn.split(',').reduce((acc: any, impact: string) => {
          acc[impact.trim()] = true;
          return acc;
        }, {}),
        reporting: {
          includePassedTests: false,
          groupByImpact: true,
          includeScreenshots: true
        },
        output: {
          format: options.format,
          path: options.output
        }
      });

      const result = await runner.run();

      const duration = Date.now() - startTime;
      console.log(`\n📊 Accessibility testing completed in ${duration}ms`);
      console.log(`   Total violations: ${result.summary.totalViolations}`);
      console.log(`   Accessibility score: ${result.summary.score}/100`);

      if (!result.summary.passed) {
        console.log(`\n❌ Accessibility violations found!`);
        console.log(`   Critical: ${result.summary.violationsBySeverity.critical || 0}`);
        console.log(`   Serious: ${result.summary.violationsBySeverity.serious || 0}`);
        console.log(`   Moderate: ${result.summary.violationsBySeverity.moderate || 0}`);
        console.log(`   Minor: ${result.summary.violationsBySeverity.minor || 0}`);

        if (options.format === 'html' && result.reportPath) {
          console.log(`\n📋 Report generated: ${result.reportPath}`);
        }

        process.exit(4); // Accessibility failure exit code
      } else {
        console.log(`\n✅ All accessibility tests passed!`);
      }

    } catch (error) {
      console.error(`\n❌ Accessibility testing failed:`, error);
      process.exit(3); // Environment/runtime error
    }
  });

// Enhance existing run command with visual assertions
const originalRunAction = program.commands.find(cmd => cmd.name() === 'run')?._actionHandler;

program
  .command('run')
  .option('--visual', 'Include visual regression checking', false)
  .option('--a11y', 'Include accessibility checking', false)
  .action(async (instruction: string, options: any) => {
    // Call original run functionality
    if (originalRunAction) {
      await originalRunAction(instruction, options);
    }

    // Add visual/accessibility testing if requested
    if (options.visual) {
      console.log('\n🎯 Running visual regression check...');
      // Integrate with visual testing
    }

    if (options.a11y) {
      console.log('\n♿ Running accessibility check...');
      // Integrate with accessibility testing
    }
  });
```

### 6.2 Enhanced Configuration Integration

```typescript
// src/config.ts (extend existing configuration)
import { z } from 'zod';
import { CaptureConfigSchema, DiffOptionsSchema } from './visual/types';
import { AccessibilityConfigSchema } from './a11y/types';

// Extend existing IrisConfig schema
const IrisConfigSchema = z.object({
  // ... existing Phase 1 configuration ...

  visual: z.object({
    enabled: z.boolean().default(false),
    baselineBranch: z.string().default('main'),
    diffThreshold: z.number().min(0).max(1).default(0.1),
    semanticAnalysis: z.object({
      enabled: z.boolean().default(false),
      provider: z.enum(['openai', 'anthropic', 'ollama']).default('openai'),
      model: z.string().optional(),
      maxTokens: z.number().default(1000),
      temperature: z.number().min(0).max(2).default(0.1)
    }),
    capture: CaptureConfigSchema,
    regions: z.array(z.object({
      name: z.string(),
      selector: z.string(),
      weight: z.number().min(0).max(5).default(1),
      description: z.string().optional()
    })).default([
      { name: 'header', selector: 'header', weight: 1.5 },
      { name: 'navigation', selector: 'nav', weight: 1.2 },
      { name: 'main-content', selector: 'main', weight: 2.0 },
      { name: 'footer', selector: 'footer', weight: 0.5 }
    ]),
    storage: z.object({
      artifactsPath: z.string().default('.iris/artifacts'),
      baselinesPath: z.string().default('.iris/baselines'),
      maxAge: z.number().default(30), // Days to keep old baselines
      compression: z.boolean().default(true)
    }),
    performance: z.object({
      maxConcurrency: z.number().min(1).max(10).default(3),
      timeoutMs: z.number().default(30000),
      retryAttempts: z.number().min(0).max(5).default(2)
    })
  }).optional(),

  accessibility: z.object({
    enabled: z.boolean().default(false),
    axe: z.object({
      rules: z.record(z.object({ enabled: z.boolean() })).default({}),
      tags: z.array(z.string()).default(['wcag2a', 'wcag2aa', 'wcag21aa']),
      include: z.array(z.string()).default([]),
      exclude: z.array(z.string()).default([]),
      disableRules: z.array(z.string()).default([]),
      timeout: z.number().default(30000)
    }),
    keyboard: z.object({
      testFocusOrder: z.boolean().default(true),
      testTrapDetection: z.boolean().default(true),
      testArrowKeyNavigation: z.boolean().default(true),
      testEscapeHandling: z.boolean().default(true),
      customSequences: z.array(z.object({
        name: z.string(),
        keys: z.array(z.string()),
        expectedOutcome: z.string(),
        startSelector: z.string().optional()
      })).default([])
    }),
    screenReader: z.object({
      testAriaLabels: z.boolean().default(true),
      testLandmarkNavigation: z.boolean().default(true),
      testImageAltText: z.boolean().default(true),
      testHeadingStructure: z.boolean().default(true),
      simulateScreenReader: z.boolean().default(false)
    }),
    failureThreshold: z.object({
      critical: z.boolean().default(true),
      serious: z.boolean().default(true),
      moderate: z.boolean().default(false),
      minor: z.boolean().default(false)
    }),
    reporting: z.object({
      includePassedTests: z.boolean().default(false),
      groupByImpact: z.boolean().default(true),
      includeScreenshots: z.boolean().default(true),
      outputPath: z.string().default('.iris/a11y-reports')
    })
  }).optional()
});

export type IrisConfig = z.infer<typeof IrisConfigSchema>;

// Configuration migration utility
export function migratePhase1Config(oldConfig: any): IrisConfig {
  const defaultVisualConfig = {
    enabled: false,
    baselineBranch: 'main',
    diffThreshold: 0.1,
    semanticAnalysis: {
      enabled: false,
      provider: 'openai' as const,
      maxTokens: 1000,
      temperature: 0.1
    },
    capture: {
      viewport: { width: 1920, height: 1080 },
      fullPage: true,
      format: 'png' as const,
      quality: 90,
      stabilization: {
        waitForFonts: true,
        disableAnimations: true,
        delay: 500,
        waitForNetworkIdle: true,
        networkIdleTimeout: 2000
      }
    },
    regions: [
      { name: 'header', selector: 'header', weight: 1.5 },
      { name: 'navigation', selector: 'nav', weight: 1.2 },
      { name: 'main-content', selector: 'main', weight: 2.0 },
      { name: 'footer', selector: 'footer', weight: 0.5 }
    ],
    storage: {
      artifactsPath: '.iris/artifacts',
      baselinesPath: '.iris/baselines',
      maxAge: 30,
      compression: true
    },
    performance: {
      maxConcurrency: 3,
      timeoutMs: 30000,
      retryAttempts: 2
    }
  };

  const defaultA11yConfig = {
    enabled: false,
    axe: {
      rules: {},
      tags: ['wcag2a', 'wcag2aa', 'wcag21aa'],
      include: [],
      exclude: [],
      disableRules: [],
      timeout: 30000
    },
    keyboard: {
      testFocusOrder: true,
      testTrapDetection: true,
      testArrowKeyNavigation: true,
      testEscapeHandling: true,
      customSequences: []
    },
    screenReader: {
      testAriaLabels: true,
      testLandmarkNavigation: true,
      testImageAltText: true,
      testHeadingStructure: true,
      simulateScreenReader: false
    },
    failureThreshold: {
      critical: true,
      serious: true,
      moderate: false,
      minor: false
    },
    reporting: {
      includePassedTests: false,
      groupByImpact: true,
      includeScreenshots: true,
      outputPath: '.iris/a11y-reports'
    }
  };

  return {
    ...oldConfig,
    visual: oldConfig.visual || defaultVisualConfig,
    accessibility: oldConfig.accessibility || defaultA11yConfig
  };
}
```

---

## 7. Performance Optimization and Scalability

### 7.1 Concurrent Processing Architecture

```typescript
// src/utils/performance-monitor.ts
import pLimit from 'p-limit';
import { EventEmitter } from 'events';

export class PerformanceMonitor extends EventEmitter {
  private metrics: Map<string, PerformanceMetric> = new Map();
  private startTimes: Map<string, number> = new Map();

  startTimer(operationId: string, operationType: string): void {
    this.startTimes.set(operationId, performance.now());
    this.emit('operation:start', { operationId, operationType });
  }

  endTimer(operationId: string, metadata?: Record<string, any>): number {
    const startTime = this.startTimes.get(operationId);
    if (!startTime) {
      throw new Error(`No start time found for operation: ${operationId}`);
    }

    const duration = performance.now() - startTime;
    this.startTimes.delete(operationId);

    const metric: PerformanceMetric = {
      operationId,
      duration,
      timestamp: Date.now(),
      metadata: metadata || {}
    };

    this.metrics.set(operationId, metric);
    this.emit('operation:end', metric);

    return duration;
  }

  getMetrics(): PerformanceMetric[] {
    return Array.from(this.metrics.values());
  }

  getAverageTime(operationType: string): number {
    const typeMetrics = this.getMetrics().filter(m =>
      m.metadata.operationType === operationType
    );

    if (typeMetrics.length === 0) return 0;

    const totalTime = typeMetrics.reduce((sum, metric) => sum + metric.duration, 0);
    return totalTime / typeMetrics.length;
  }

  clearMetrics(): void {
    this.metrics.clear();
    this.startTimes.clear();
  }
}

interface PerformanceMetric {
  operationId: string;
  duration: number;
  timestamp: number;
  metadata: Record<string, any>;
}

// src/visual/visual-runner.ts
export class VisualTestRunner {
  private performanceMonitor = new PerformanceMonitor();
  private concurrencyLimit: pLimit.Limit;

  constructor(private config: VisualTestConfig) {
    this.concurrencyLimit = pLimit(config.performance?.maxConcurrency || 3);
  }

  async run(): Promise<VisualTestRun> {
    const runId = `visual-run-${Date.now()}`;
    this.performanceMonitor.startTimer(runId, 'visual-test-run');

    try {
      console.log(`🎯 Starting visual test run: ${runId}`);
      console.log(`   Pages: ${this.config.pages.join(', ')}`);
      console.log(`   Concurrency: ${this.config.performance?.maxConcurrency || 3}`);

      // Phase 1: Capture screenshots for all pages
      const captureResults = await this.capturePhase();

      // Phase 2: Compare with baselines
      const comparisonResults = await this.comparisonPhase(captureResults);

      // Phase 3: Generate reports
      const reportResults = await this.reportingPhase(comparisonResults);

      const duration = this.performanceMonitor.endTimer(runId, {
        operationType: 'visual-test-run',
        pagesCount: this.config.pages.length,
        comparisonsCount: comparisonResults.length
      });

      console.log(`✅ Visual test run completed in ${duration.toFixed(2)}ms`);

      return {
        id: runId,
        timestamp: Date.now(),
        pages: this.config.pages,
        baseline: this.config.baseline,
        results: comparisonResults,
        summary: this.generateSummary(comparisonResults),
        config: {
          capture: this.config.capture,
          diff: this.config.diff
        },
        environment: await this.getEnvironmentInfo()
      };

    } catch (error) {
      this.performanceMonitor.endTimer(runId, {
        operationType: 'visual-test-run',
        error: error.message
      });
      throw error;
    }
  }

  private async capturePhase(): Promise<CaptureResult[]> {
    console.log('📸 Phase 1: Capturing screenshots...');

    const capturePromises = this.config.pages.map(page =>
      this.concurrencyLimit(async () => {
        const captureId = `capture-${page}-${Date.now()}`;
        this.performanceMonitor.startTimer(captureId, 'screenshot-capture');

        try {
          const result = await this.captureEngine.capture(page, this.config.capture);

          this.performanceMonitor.endTimer(captureId, {
            operationType: 'screenshot-capture',
            page,
            imageSize: result.metadata.viewport.width * result.metadata.viewport.height
          });

          return result;
        } catch (error) {
          this.performanceMonitor.endTimer(captureId, {
            operationType: 'screenshot-capture',
            page,
            error: error.message
          });
          throw error;
        }
      })
    );

    return Promise.all(capturePromises);
  }

  private async comparisonPhase(captures: CaptureResult[]): Promise<DiffResult[]> {
    console.log('🔍 Phase 2: Comparing with baselines...');

    const comparisonPromises = captures.map(capture =>
      this.concurrencyLimit(async () => {
        const comparisonId = `comparison-${capture.url}-${Date.now()}`;
        this.performanceMonitor.startTimer(comparisonId, 'visual-comparison');

        try {
          const baseline = await this.baselineManager.getBaseline(
            capture.url,
            undefined,
            this.config.baseline
          );

          if (!baseline) {
            if (this.config.updateBaseline) {
              await this.baselineManager.setBaseline(capture, {
                branch: this.config.baseline.reference,
                commit: await this.getGitCommit(),
                url: capture.url
              });

              // Return a "no difference" result for new baselines
              return this.createNoChangeResult(capture);
            } else {
              throw new Error(`No baseline found for ${capture.url}`);
            }
          }

          const result = await this.diffEngine.compare(
            await this.loadBaselineImage(baseline),
            await this.loadCaptureImage(capture),
            this.config.diff
          );

          this.performanceMonitor.endTimer(comparisonId, {
            operationType: 'visual-comparison',
            url: capture.url,
            pixelDiffPercentage: result.pixelDiff.percentage,
            severity: result.overall.severity
          });

          return result;
        } catch (error) {
          this.performanceMonitor.endTimer(comparisonId, {
            operationType: 'visual-comparison',
            url: capture.url,
            error: error.message
          });
          throw error;
        }
      })
    );

    return Promise.all(comparisonPromises);
  }
}
```

### 7.2 Memory Management and Resource Optimization

```typescript
// src/utils/image-processor.ts
import sharp from 'sharp';
import { createHash } from 'crypto';
import { LRUCache } from 'lru-cache';

export class ImageProcessor {
  private imageCache = new LRUCache<string, Buffer>({
    max: 50, // Maximum 50 images in cache
    maxSize: 100 * 1024 * 1024, // 100MB max cache size
    sizeCalculation: (value: Buffer) => value.length,
    dispose: (value: Buffer, key: string) => {
      console.debug(`Evicting image from cache: ${key} (${value.length} bytes)`);
    }
  });

  async processImage(
    imagePath: string,
    options: ImageProcessingOptions = {}
  ): Promise<ProcessedImageResult> {
    const cacheKey = this.generateCacheKey(imagePath, options);
    const cached = this.imageCache.get(cacheKey);

    if (cached) {
      return {
        buffer: cached,
        hash: this.calculateHash(cached),
        metadata: await this.getImageMetadata(cached)
      };
    }

    let pipeline = sharp(imagePath);

    // Apply transformations
    if (options.resize) {
      pipeline = pipeline.resize(options.resize.width, options.resize.height, {
        fit: options.resize.fit || 'inside',
        withoutEnlargement: true
      });
    }

    if (options.format) {
      switch (options.format) {
        case 'png':
          pipeline = pipeline.png({
            quality: options.quality || 90,
            progressive: true,
            compressionLevel: 6
          });
          break;
        case 'jpeg':
          pipeline = pipeline.jpeg({
            quality: options.quality || 90,
            progressive: true
          });
          break;
        case 'webp':
          pipeline = pipeline.webp({
            quality: options.quality || 90,
            effort: 6
          });
          break;
      }
    }

    const buffer = await pipeline.toBuffer();
    const hash = this.calculateHash(buffer);
    const metadata = await this.getImageMetadata(buffer);

    // Cache the result
    this.imageCache.set(cacheKey, buffer);

    return { buffer, hash, metadata };
  }

  async optimizeForComparison(imageBuffer: Buffer): Promise<Buffer> {
    // Optimize images for visual comparison
    return sharp(imageBuffer)
      .png({ quality: 100, compressionLevel: 0 }) // Lossless for accurate comparison
      .toBuffer();
  }

  async generateThumbnail(imageBuffer: Buffer, size: number = 200): Promise<Buffer> {
    return sharp(imageBuffer)
      .resize(size, size, { fit: 'inside' })
      .png({ quality: 80 })
      .toBuffer();
  }

  private calculateHash(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex');
  }

  private generateCacheKey(imagePath: string, options: ImageProcessingOptions): string {
    return createHash('md5')
      .update(imagePath + JSON.stringify(options))
      .digest('hex');
  }

  private async getImageMetadata(buffer: Buffer): Promise<ImageMetadata> {
    const metadata = await sharp(buffer).metadata();
    return {
      width: metadata.width || 0,
      height: metadata.height || 0,
      format: metadata.format || 'unknown',
      size: buffer.length,
      hasAlpha: metadata.hasAlpha || false,
      density: metadata.density || 72
    };
  }

  clearCache(): void {
    this.imageCache.clear();
  }

  getCacheStats(): { size: number; itemCount: number; hitRate: number } {
    return {
      size: this.imageCache.size,
      itemCount: this.imageCache.size,
      hitRate: 0 // LRU cache doesn't provide hit rate by default
    };
  }
}

interface ImageProcessingOptions {
  resize?: {
    width: number;
    height: number;
    fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside';
  };
  format?: 'png' | 'jpeg' | 'webp';
  quality?: number;
}

interface ProcessedImageResult {
  buffer: Buffer;
  hash: string;
  metadata: ImageMetadata;
}

interface ImageMetadata {
  width: number;
  height: number;
  format: string;
  size: number;
  hasAlpha: boolean;
  density: number;
}
```

### 7.3 AI Service Rate Limiting and Caching

```typescript
// src/visual/ai-classifier.ts
import { LRUCache } from 'lru-cache';
import pQueue from 'p-queue';

export class AIVisualClassifier {
  private resultCache = new LRUCache<string, VisualAnalysisResponse>({
    max: 500,
    ttl: 1000 * 60 * 60 * 24, // 24 hours
  });

  private requestQueue = new pQueue({
    concurrency: 1, // AI services often have rate limits
    interval: 1000, // 1 second intervals
    intervalCap: 10 // Max 10 requests per second
  });

  private rateLimiters = new Map<string, pQueue>();

  constructor(private config: AIClassifierConfig) {
    // Initialize rate limiters for different providers
    this.rateLimiters.set('openai', new pQueue({
      concurrency: 3,
      interval: 60000, // 1 minute
      intervalCap: 100 // 100 requests per minute for OpenAI
    }));

    this.rateLimiters.set('anthropic', new pQueue({
      concurrency: 2,
      interval: 60000,
      intervalCap: 50 // More conservative for Anthropic
    }));

    this.rateLimiters.set('ollama', new pQueue({
      concurrency: 1,
      interval: 1000,
      intervalCap: 5 // Local model, conservative concurrency
    }));
  }

  async analyzeVisualChange(
    baselineImage: Buffer,
    candidateImage: Buffer,
    context?: VisualAnalysisRequest
  ): Promise<VisualAnalysisResponse> {
    // Generate cache key based on image hashes and context
    const cacheKey = this.generateCacheKey(baselineImage, candidateImage, context);
    const cached = this.resultCache.get(cacheKey);

    if (cached) {
      console.debug(`AI analysis cache hit: ${cacheKey}`);
      return cached;
    }

    // Try providers in order of preference with fallback
    const providers = this.config.providers || ['openai', 'anthropic', 'ollama'];
    let lastError: Error | null = null;

    for (const provider of providers) {
      try {
        const rateLimiter = this.rateLimiters.get(provider);
        if (!rateLimiter) {
          throw new Error(`No rate limiter configured for provider: ${provider}`);
        }

        const result = await rateLimiter.add(async () => {
          console.debug(`Attempting AI analysis with provider: ${provider}`);
          return this.analyzeWithProvider(provider, baselineImage, candidateImage, context);
        });

        // Cache successful result
        this.resultCache.set(cacheKey, result);
        console.debug(`AI analysis successful with provider: ${provider}`);

        return result;
      } catch (error) {
        lastError = error as Error;
        console.warn(`AI analysis failed with provider ${provider}:`, error.message);
        continue;
      }
    }

    // All providers failed, fall back to rule-based analysis
    console.warn('All AI providers failed, falling back to rule-based analysis');
    const fallbackResult = this.performRuleBasedAnalysis(baselineImage, candidateImage, context);

    // Cache fallback result with shorter TTL
    this.resultCache.set(cacheKey, fallbackResult, { ttl: 1000 * 60 * 10 }); // 10 minutes

    return fallbackResult;
  }

  private async analyzeWithProvider(
    provider: string,
    baselineImage: Buffer,
    candidateImage: Buffer,
    context?: VisualAnalysisRequest
  ): Promise<VisualAnalysisResponse> {
    const startTime = performance.now();

    try {
      switch (provider) {
        case 'openai':
          return await this.analyzeWithOpenAI(baselineImage, candidateImage, context);
        case 'anthropic':
          return await this.analyzeWithAnthropic(baselineImage, candidateImage, context);
        case 'ollama':
          return await this.analyzeWithOllama(baselineImage, candidateImage, context);
        default:
          throw new Error(`Unsupported AI provider: ${provider}`);
      }
    } finally {
      const duration = performance.now() - startTime;
      console.debug(`AI analysis with ${provider} took ${duration.toFixed(2)}ms`);
    }
  }

  private async analyzeWithOpenAI(
    baselineImage: Buffer,
    candidateImage: Buffer,
    context?: VisualAnalysisRequest
  ): Promise<VisualAnalysisResponse> {
    const openai = this.getOpenAIClient();

    const prompt = this.buildAnalysisPrompt(context);
    const baselineBase64 = baselineImage.toString('base64');
    const candidateBase64 = candidateImage.toString('base64');

    const response = await openai.chat.completions.create({
      model: this.config.openai.model || 'gpt-4-vision-preview',
      messages: [
        {
          role: 'system',
          content: 'You are an expert UI/UX analyst specializing in visual regression detection.'
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/png;base64,${baselineBase64}`,
                detail: 'high'
              }
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/png;base64,${candidateBase64}`,
                detail: 'high'
              }
            }
          ]
        }
      ],
      max_tokens: this.config.openai.maxTokens || 1000,
      temperature: this.config.openai.temperature || 0.1
    });

    return this.parseAIResponse(response.choices[0]?.message?.content || '', 'openai');
  }

  private performRuleBasedAnalysis(
    baselineImage: Buffer,
    candidateImage: Buffer,
    context?: VisualAnalysisRequest
  ): VisualAnalysisResponse {
    // Implement rule-based fallback analysis
    // This would use image processing algorithms without AI

    return {
      semanticSimilarity: 0.5, // Conservative estimate
      changeDescription: 'Rule-based analysis detected visual differences',
      changeType: 'mixed',
      intentional: false, // Conservative assumption
      confidence: 0.3, // Low confidence for rule-based analysis
      reasoning: 'Analysis performed without AI due to service unavailability',
      provider: 'rule-based',
      processingTime: 0
    };
  }

  private generateCacheKey(
    baselineImage: Buffer,
    candidateImage: Buffer,
    context?: VisualAnalysisRequest
  ): string {
    const baselineHash = createHash('sha256').update(baselineImage).digest('hex').substring(0, 16);
    const candidateHash = createHash('sha256').update(candidateImage).digest('hex').substring(0, 16);
    const contextHash = context ?
      createHash('md5').update(JSON.stringify(context)).digest('hex').substring(0, 8) :
      'no-context';

    return `${baselineHash}-${candidateHash}-${contextHash}`;
  }

  getCacheStats(): { size: number; hitRate: number } {
    return {
      size: this.resultCache.size,
      hitRate: 0 // LRU cache doesn't provide hit rate by default
    };
  }

  clearCache(): void {
    this.resultCache.clear();
  }
}
```

---

## 8. Implementation Success Metrics and Quality Gates

### 8.1 Technical Performance Targets

| Metric | Target | Measurement Method | Validation Strategy |
|--------|--------|-------------------|-------------------|
| **Visual Diff Accuracy** | >95% intentional vs unintentional classification | A/B testing with 500+ known change sets | Continuous validation with user feedback |
| **Processing Speed** | <10s full-page visual diff with AI | Automated benchmarking in CI | Performance regression alerts |
| **False Positive Rate** | <1% for regression detection | Historical analysis validation | Monthly analysis of production usage |
| **Memory Usage** | <500MB peak for 10 concurrent tests | Memory profiling and monitoring | Load testing with resource constraints |
| **Test Coverage** | >90% for all Phase 2 modules | Jest coverage reports | Coverage gates in CI/CD |
| **AI Service Reliability** | 99%+ uptime with fallback | Service monitoring and alerting | Fallback activation testing |

### 8.2 User Experience Quality Gates

| Metric | Target | Validation Method | Success Criteria |
|--------|--------|-------------------|------------------|
| **Setup Time** | <5 minutes from installation to first test | User journey automation | 95% success rate in automated tests |
| **Actionable Guidance** | >90% flagged issues include remediation | Content quality analysis | User feedback scoring >4/5 |
| **CI Pipeline Overhead** | <30 seconds for typical test suite | CI/CD integration benchmarking | Performance budgets enforced |
| **Baseline Storage** | <100MB for typical projects | Storage analysis across projects | Automated storage optimization |
| **Error Recovery** | 100% graceful degradation scenarios | Chaos engineering testing | Zero unhandled exceptions |

### 8.3 Integration Quality Assurance

| Quality Gate | Criteria | Validation Process | Acceptance Threshold |
|--------------|----------|-------------------|---------------------|
| **Zero Breaking Changes** | All Phase 1 functionality preserved | Regression test suite execution | 122/122 Phase 1 tests must pass |
| **Database Migration** | Schema migration without data loss | Migration test scenarios | 100% data integrity validation |
| **Backward Compatibility** | Phase 1 configs continue working | Configuration validation tests | All existing configs load successfully |
| **Performance Baseline** | No performance regression | Benchmark comparison | <10% degradation in Phase 1 operations |

---

## 9. Risk Mitigation Strategy

### 9.1 Technical Risk Mitigation

**Risk: AI Service Reliability and Cost**
- **Impact**: High - Core visual analysis feature dependency
- **Probability**: Medium - External service dependencies
- **Mitigation Strategy**:
  - Multi-provider fallback (OpenAI → Anthropic → Ollama → Rule-based)
  - Aggressive caching with 24-hour TTL
  - Local model support via Ollama for critical environments
  - Request batching and rate limiting
  - Cost monitoring and budget alerts
- **Contingency Plan**: Rule-based analysis algorithms as permanent fallback
- **Monitoring**: Service health checks, response time tracking, cost analysis

**Risk: Performance Degradation at Scale**
- **Impact**: High - User experience and CI/CD integration
- **Probability**: Medium - Complex image processing operations
- **Mitigation Strategy**:
  - Parallel processing with configurable concurrency limits
  - Memory-efficient image processing with Sharp
  - Intelligent caching at multiple layers
  - Progressive enhancement (start simple, add features)
  - Performance budgets with automated alerts
- **Contingency Plan**: Feature flags to disable expensive operations
- **Monitoring**: Performance metrics, memory usage, processing times

**Risk: Integration Complexity with Phase 1**
- **Impact**: Medium - Project timeline and quality
- **Probability**: Low - Well-defined interfaces in Phase 1
- **Mitigation Strategy**:
  - Extensive integration testing
  - Gradual rollout with feature flags
  - Backward compatibility guarantees
  - Comprehensive migration testing
  - Rollback procedures documented
- **Contingency Plan**: Incremental delivery with Phase 1 fallback modes
- **Monitoring**: Integration test results, error rates, user feedback

### 9.2 Quality Risk Mitigation

**Risk: False Positive/Negative Visual Diffs**
- **Impact**: High - User trust and adoption
- **Probability**: Medium - Complex visual analysis algorithms
- **Mitigation Strategy**:
  - Extensive golden image test datasets
  - AI model validation with known change sets
  - User feedback collection and model improvement
  - Configurable thresholds and sensitivity
  - Manual review workflows for edge cases
- **Contingency Plan**: Conservative thresholds with manual override options
- **Monitoring**: False positive rates, user feedback scores, classification accuracy

**Risk: Accessibility Test Coverage Gaps**
- **Impact**: Medium - Compliance and quality goals
- **Probability**: Low - Industry-standard axe-core foundation
- **Mitigation Strategy**:
  - Comprehensive axe-core rule coverage
  - Regular rule updates and maintenance
  - Manual validation processes
  - Community feedback integration
  - Expert accessibility consultation
- **Contingency Plan**: Manual accessibility audit processes
- **Monitoring**: Rule coverage metrics, violation detection rates, compliance scores

---

## 10. Implementation Timeline and Milestones

### 10.1 Week 1-2: Foundation Setup
**Milestone**: Core architecture and development environment ready

**Deliverables:**
- [ ] Phase 2 module directory structure created
- [ ] TypeScript interfaces and schemas implemented
- [ ] Zod validation schemas for all configurations
- [ ] Database migration scripts created and tested
- [ ] Core dependencies added and configured
- [ ] Testing framework extensions setup
- [ ] Development environment validation

**Success Criteria:**
- All TypeScript compiles without errors
- Database migrations apply and rollback successfully
- Basic test structure executes correctly
- Development environment reproduces across team

### 10.2 Week 3-4: Core Visual Engine Implementation
**Milestone**: Visual regression testing engine operational

**Deliverables:**
- [ ] VisualCaptureEngine with Playwright integration
- [ ] Image stabilization and masking functionality
- [ ] VisualDiffEngine with SSIM and pixel comparison
- [ ] BaselineManager with Git integration
- [ ] AI visual classifier integration (OpenAI/Anthropic/Ollama)
- [ ] Performance optimization (concurrency, caching)
- [ ] Comprehensive error handling and recovery

**Success Criteria:**
- Screenshot capture works across different viewports
- Visual diff accuracy >90% on test datasets
- Baseline management integrates with Git workflow
- AI classification provides reasonable results
- Error scenarios handled gracefully

### 10.3 Week 5-6: Accessibility & CLI Integration
**Milestone**: Accessibility testing and CLI commands functional

**Deliverables:**
- [ ] AxeRunner with comprehensive WCAG 2.1 AA coverage
- [ ] Keyboard navigation testing automation
- [ ] Screen reader simulation capabilities
- [ ] `iris visual-diff` command implementation
- [ ] `iris a11y` command implementation
- [ ] Enhanced `iris run` with visual/accessibility options
- [ ] Configuration system integration
- [ ] CLI help documentation and error messages

**Success Criteria:**
- All accessibility tests execute correctly
- Keyboard navigation issues detected accurately
- CLI commands provide intuitive user experience
- Configuration loading works across different formats
- Help documentation is comprehensive and clear

### 10.4 Week 7-8: Reporting, Optimization & Production Readiness
**Milestone**: Production-ready Phase 2 implementation

**Deliverables:**
- [ ] Multi-format report generation (HTML/JSON/JUnit)
- [ ] Interactive HTML reports with diff visualization
- [ ] Performance optimizations and benchmarking
- [ ] Comprehensive test coverage (>90%)
- [ ] Documentation and examples
- [ ] CI/CD integration examples
- [ ] Migration guides and troubleshooting

**Success Criteria:**
- All performance targets met
- Test coverage exceeds 90% for Phase 2 modules
- Reports are visually appealing and actionable
- CI/CD integration examples work correctly
- All 122 Phase 1 tests continue to pass
- Documentation enables successful adoption

---

## 11. Post-Implementation: Validation and Launch

### 11.1 Pre-Launch Validation Checklist

**Technical Validation:**
- [ ] All unit tests pass (target: >150 tests for Phase 2)
- [ ] Integration tests validate end-to-end workflows
- [ ] Performance benchmarks meet targets
- [ ] Memory usage stays within bounds
- [ ] AI service fallbacks work correctly
- [ ] Error handling covers all edge cases

**Quality Validation:**
- [ ] Visual diff accuracy validated with test datasets
- [ ] Accessibility test coverage verified with real websites
- [ ] False positive rates measured and documented
- [ ] User experience validated through usability testing
- [ ] Documentation reviewed by technical writers

**Integration Validation:**
- [ ] Phase 1 regression tests pass 100%
- [ ] Database migrations tested with real data
- [ ] Configuration migration works seamlessly
- [ ] CLI commands integrate smoothly
- [ ] Performance impact on Phase 1 operations measured

### 11.2 Launch Strategy

**Beta Release (Week 9):**
- Limited feature flag rollout
- Internal team validation
- Performance monitoring setup
- User feedback collection system
- Bug tracking and resolution process

**Gradual Rollout (Week 10-11):**
- Staged feature availability
- Community feedback integration
- Performance optimization based on real usage
- Documentation refinement
- Support process establishment

**Full Release (Week 12):**
- Complete feature availability
- Comprehensive documentation
- Migration support for existing users
- Performance monitoring and alerting
- Success metrics tracking

---

## Conclusion

This comprehensive technical architecture plan provides a robust foundation for implementing IRIS Phase 2 Visual Regression & Accessibility testing capabilities. The design emphasizes:

1. **Seamless Integration** with the proven Phase 1 foundation (ActionExecutor, CLI, Browser automation)
2. **Production-Ready Quality** with comprehensive error handling, performance optimization, and monitoring
3. **AI-Enhanced Capabilities** for intelligent visual analysis while maintaining fallback options
4. **Industry-Standard Compliance** with WCAG 2.1 AA requirements using axe-core
5. **Test-Driven Development** with >90% code coverage and comprehensive validation

**Key Architectural Decisions:**
- Modular design enabling independent development and testing
- Multi-provider AI integration with intelligent fallbacks
- Performance-first approach with concurrent processing and caching
- Comprehensive type safety using Zod schemas
- Database migration strategy preserving Phase 1 data integrity

**Implementation Success Factors:**
- Clear separation of concerns between visual and accessibility modules
- Extensive test coverage ensuring reliability and maintainability
- Performance optimization strategies for production scalability
- User-centric CLI design with intuitive commands and helpful output
- Comprehensive documentation and migration guides

This architecture positions IRIS as a comprehensive UI testing solution that combines traditional automation with cutting-edge AI-powered visual and accessibility analysis, setting a new standard for intelligent UI testing tools.

**Next Actions:**
1. Technical review and approval of this architecture plan
2. Resource allocation and team assignment for 8-week implementation
3. Development environment setup with Phase 2 structure
4. Implementation kickoff following TDD methodology
5. Weekly milestone reviews and course corrections as needed

The implementation will deliver significant value enhancement to IRIS while maintaining the high quality standards and architectural principles established in Phase 1.