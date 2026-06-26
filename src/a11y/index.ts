/**
 * IRIS Accessibility Testing Module
 *
 * Provides comprehensive accessibility testing capabilities including:
 * - WCAG 2.1 AA compliance validation with axe-core
 * - Keyboard navigation and focus management testing
 * - Screen reader simulation and ARIA validation
 * - Color contrast and visual accessibility checks
 * - Multi-format accessibility reporting
 */

// Core types and interfaces
export type {
  A11yTestConfig,
  A11yViolation,
  A11yResult,
  KeyboardTestResult,
  ScreenReaderTestResult,
  A11yReport,
  A11yTestOptions,
  KeyboardNavigationTest,
  FocusManagementTest,
  AriaValidationTest,
  ColorContrastTest,
  ScreenReaderTest,
  WcagLevel,
  WcagPrinciple,
  ImpactLevel,
  WcagGuideline,
  ComplianceStatus,
} from './types';

// Error classes
export { A11yTestError, AxeRunnerError, KeyboardNavigationError, ScreenReaderError } from './types';

// Zod schemas for validation
export {
  A11yTestConfigSchema,
  A11yViolationSchema,
  A11yResultSchema,
  KeyboardTestResultSchema,
  ScreenReaderTestResultSchema,
  A11yReportSchema,
} from './types';

// Core testing engines
export { AxeRunner } from './axe-integration';
export { KeyboardTester } from './keyboard-tester';
export { AccessibilityRunner } from './a11y-runner';

// Export additional types from runners
export type { AxeConfig, AxeRunOptions } from './axe-integration';

export type {
  KeyboardTestConfig,
  FocusableElement,
  FocusTrap,
  KeyboardInteraction,
} from './keyboard-tester';

export type { AccessibilityRunnerConfig, AccessibilityTestResult } from './a11y-runner';
