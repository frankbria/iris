import { z } from 'zod';

// Zod schemas for runtime validation
export const VisualTestConfigSchema = z.object({
  testName: z.string().min(1),
  url: z.string().url(),
  viewport: z.object({
    width: z.number().min(320),
    height: z.number().min(240)
  }).optional(),
  selector: z.string().optional(),
  threshold: z.number().min(0).max(1).default(0.1),
  ignoreRegions: z.array(z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number()
  })).optional(),
  waitForSelector: z.string().optional(),
  waitForTimeout: z.number().min(0).max(30000).default(5000),
  disableAnimations: z.boolean().default(true),
  fullPage: z.boolean().default(false),
  clip: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number()
  }).optional()
});

export const VisualDiffResultSchema = z.object({
  testName: z.string(),
  passed: z.boolean(),
  similarity: z.number().min(0).max(1),
  pixelDifference: z.number().min(0),
  threshold: z.number().min(0).max(1),
  baselineExists: z.boolean(),
  screenshotPath: z.string(),
  baselinePath: z.string().optional(),
  diffPath: z.string().optional(),
  timestamp: z.date(),
  viewport: z.object({
    width: z.number(),
    height: z.number()
  }),
  metadata: z.record(z.any()).optional()
});

export const VisualReportSchema = z.object({
  testSuite: z.string(),
  timestamp: z.date(),
  summary: z.object({
    total: z.number(),
    passed: z.number(),
    failed: z.number(),
    newBaselines: z.number()
  }),
  results: z.array(VisualDiffResultSchema),
  environment: z.object({
    browser: z.string(),
    viewport: z.object({
      width: z.number(),
      height: z.number()
    }),
    platform: z.string(),
    gitBranch: z.string().optional(),
    gitCommit: z.string().optional()
  })
});

// TypeScript types derived from schemas
export type VisualTestConfig = z.infer<typeof VisualTestConfigSchema>;
export type VisualDiffResult = z.infer<typeof VisualDiffResultSchema>;
export type VisualReport = z.infer<typeof VisualReportSchema>;

// Additional interfaces for internal use
export interface IgnoreRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface ClipRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenshotOptions {
  path: string;
  fullPage?: boolean;
  clip?: ClipRegion;
  quality?: number;
  type?: 'png' | 'jpeg';
}

export interface BaselineInfo {
  exists: boolean;
  path?: string;
  lastModified?: Date;
  gitBranch?: string;
  gitCommit?: string;
}

export interface BaselineMetadata {
  url: string;
  title: string;
  timestamp: number;
  viewport: Viewport;
  gitBranch?: string;
  gitCommit?: string;
  [key: string]: any;
}

export interface BaselineSaveResult {
  success: boolean;
  path?: string;
  error?: string;
}

export interface BaselineLoadResult {
  success: boolean;
  buffer?: Buffer;
  metadata?: BaselineMetadata;
  error?: string;
}

export interface BaselineDeleteResult {
  success: boolean;
  error?: string;
}

export interface BaselineCleanupResult {
  success: boolean;
  deletedCount?: number;
  error?: string;
}

// Diff Engine Types
export interface DiffOptions {
  threshold: number;
  includeAA: boolean;
  alpha: number;
  diffMask: boolean;
  diffColor: [number, number, number];
}

export interface DiffResult {
  success: boolean;
  passed: boolean;
  similarity: number;
  pixelDifference: number;
  threshold: number;
  diffBuffer?: Buffer;
  error?: string;
}

export interface SSIMResult {
  success: boolean;
  ssim?: number;
  mcs?: number;
  error?: string;
}

export interface DiffAnalysis {
  similarity: number;
  pixelDifference: number;
  regions: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
    significance: number;
  }>;
  classification: 'layout' | 'content' | 'styling' | 'animation' | 'unknown';
}

export interface PreparedImage {
  buffer: Buffer;
  width: number;
  height: number;
  channels: number;
}

export interface VisualTestOptions {
  config: VisualTestConfig;
  baselineDir: string;
  outputDir: string;
  updateBaselines?: boolean;
  generateReport?: boolean;
  failOnNewBaselines?: boolean;
}

// Capture Engine Types
export interface CaptureConfig {
  selector?: string;
  fullPage: boolean;
  maskSelectors: string[];
  stabilizeMs: number;
  disableAnimations: boolean;
  clip?: ClipRegion;
  quality?: number;
  type?: 'png' | 'jpeg';
}

export interface CaptureResult {
  success: boolean;
  buffer?: Buffer;
  metadata: CaptureMetadata;
  error?: string;
}

export interface CaptureMetadata {
  url: string;
  title: string;
  fullPage: boolean;
  viewport: Viewport;
  hash: string;
  timestamp: number;
  selector?: string;
  maskSelectors?: string[];
  stabilizeMs?: number;
  disableAnimations?: boolean;
}

export interface CaptureStabilizationOptions {
  maxWaitTime: number;
  stabilityThreshold: number;
  intervalMs: number;
  disableAnimations: boolean;
  hideElements?: string[];
  waitForFonts: boolean;
}

export interface AIVisualAnalysis {
  classification: string;
  confidence: number;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  suggestions: string[];
  regions?: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
    type: string;
    description: string;
  }>;
}

// Error types for visual testing
export class VisualTestError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: Record<string, any>
  ) {
    super(message);
    this.name = 'VisualTestError';
  }
}

export class BaselineNotFoundError extends VisualTestError {
  constructor(testName: string, baselinePath: string) {
    super(
      `Baseline not found for test '${testName}' at path '${baselinePath}'`,
      'BASELINE_NOT_FOUND',
      { testName, baselinePath }
    );
  }
}

export class ScreenshotCaptureError extends VisualTestError {
  constructor(message: string, details?: Record<string, any>) {
    super(message, 'SCREENSHOT_CAPTURE_ERROR', details);
  }
}

export class DiffAnalysisError extends VisualTestError {
  constructor(message: string, details?: Record<string, any>) {
    super(message, 'DIFF_ANALYSIS_ERROR', details);
  }
}