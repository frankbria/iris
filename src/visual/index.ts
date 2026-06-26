/**
 * IRIS Visual Regression Testing Module
 *
 * Provides comprehensive visual regression testing capabilities including:
 * - Screenshot capture with stabilization
 * - SSIM and pixel-based image comparison
 * - Git-integrated baseline management
 * - AI-powered visual anomaly detection
 * - Multi-format reporting (HTML, JSON, JUnit)
 */

// Core types and interfaces
export type {
  VisualTestConfig,
  VisualDiffResult,
  VisualReport,
  IgnoreRegion,
  Viewport,
  ClipRegion,
  ScreenshotOptions,
  BaselineInfo,
  DiffAnalysis,
  VisualTestOptions,
  CaptureStabilizationOptions,
  AIVisualAnalysis,
} from './types';

// Error classes
export {
  VisualTestError,
  BaselineNotFoundError,
  ScreenshotCaptureError,
  DiffAnalysisError,
} from './types';

// Zod schemas for validation
export { VisualTestConfigSchema, VisualDiffResultSchema, VisualReportSchema } from './types';

// Core engines
export { VisualCaptureEngine } from './capture';
export { VisualDiffEngine } from './diff';
export { BaselineManager } from './baseline';
export { StorageManager } from './storage';
export { AIVisualClassifier } from './ai-classifier';
export { VisualTestRunner } from './visual-runner';
export { VisualReporter } from './reporter';

// AI Classifier types
export type {
  AIProvider,
  AIProviderConfig,
  PreparedImageForAI,
  AIAnalysisRequest,
  AIAnalysisResponse,
} from './ai-classifier';

// Visual Test Runner types
export type { VisualTestRunnerConfig, VisualTestResult } from './visual-runner';

// Visual Reporter types
export type { ReportConfig, ReportArtifacts } from './reporter';
