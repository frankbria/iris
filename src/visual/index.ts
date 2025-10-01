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
  AIVisualAnalysis
} from './types';

// Import types for function signatures
import type {
  VisualTestConfig,
  VisualDiffResult
} from './types';

// Error classes
export {
  VisualTestError,
  BaselineNotFoundError,
  ScreenshotCaptureError,
  DiffAnalysisError
} from './types';

// Zod schemas for validation
export {
  VisualTestConfigSchema,
  VisualDiffResultSchema,
  VisualReportSchema
} from './types';

// Core engines
export { VisualCaptureEngine } from './capture';
export { VisualDiffEngine } from './diff';
export { BaselineManager } from './baseline';
export { StorageManager } from './storage';

// Import implementations for the public API
import { VisualCaptureEngine } from './capture';
import { VisualDiffEngine } from './diff';
import { BaselineManager } from './baseline';
import { StorageManager } from './storage';

/**
 * Main entry point for visual regression testing.
 *
 * Example usage:
 * ```typescript
 * import { runVisualTest } from '@iris/visual';
 *
 * const config: VisualTestConfig = {
 *   testName: 'homepage-desktop',
 *   url: 'https://example.com',
 *   viewport: { width: 1920, height: 1080 },
 *   threshold: 0.1
 * };
 *
 * const result = await runVisualTest(config);
 * console.log(`Test ${result.passed ? 'passed' : 'failed'}: ${result.similarity}`);
 * ```
 */
export async function runVisualTest(config: VisualTestConfig): Promise<VisualDiffResult> {
  // Basic implementation using the underlying engines
  // This is a simplified version - full orchestration would be more complex
  throw new Error('Full visual test orchestration not yet implemented - use VisualCaptureEngine, VisualDiffEngine, and BaselineManager directly');
}

/**
 * Generate visual regression test report.
 *
 * @param results Array of visual test results
 * @param format Output format (html, json, junit)
 * @param outputPath Output file path
 */
export async function generateVisualReport(
  results: VisualDiffResult[],
  format: 'html' | 'json' | 'junit' = 'html',
  outputPath?: string
): Promise<string> {
  // Basic report generation - simplified implementation
  if (format === 'json') {
    const report = JSON.stringify(results, null, 2);
    if (outputPath) {
      const fs = await import('fs');
      fs.writeFileSync(outputPath, report);
    }
    return report;
  }
  throw new Error('HTML and JUnit report generation not yet implemented - JSON format available');
}

/**
 * Update baseline images for specified tests.
 *
 * @param testNames Test names to update baselines for
 * @param branch Git branch for baseline storage
 */
export async function updateBaselines(
  testNames: string[],
  branch: string = 'main'
): Promise<void> {
  // Basic baseline update implementation
  throw new Error('Baseline update requires test execution context - use BaselineManager directly');
}