import { z } from 'zod';

// Zod schemas for runtime validation
export const A11yTestConfigSchema = z.object({
  testName: z.string().min(1),
  url: z.string().url(),
  selector: z.string().optional(),
  rules: z.object({
    wcag2a: z.boolean().default(true),
    wcag2aa: z.boolean().default(true),
    wcag2aaa: z.boolean().default(false),
    section508: z.boolean().default(false),
    bestPractice: z.boolean().default(true)
  }).optional(),
  tags: z.array(z.string()).optional(),
  excludeRules: z.array(z.string()).optional(),
  includeRules: z.array(z.string()).optional(),
  disableRules: z.array(z.string()).optional(),
  timeout: z.number().min(0).max(60000).default(10000)
});

export const A11yViolationSchema = z.object({
  id: z.string(),
  impact: z.enum(['minor', 'moderate', 'serious', 'critical']),
  tags: z.array(z.string()),
  description: z.string(),
  help: z.string(),
  helpUrl: z.string(),
  nodes: z.array(z.object({
    target: z.array(z.string()),
    html: z.string(),
    failureSummary: z.string().optional(),
    element: z.string().optional()
  }))
});

export const A11yResultSchema = z.object({
  testName: z.string(),
  url: z.string(),
  timestamp: z.date(),
  passed: z.boolean(),
  violations: z.array(A11yViolationSchema),
  passes: z.array(z.object({
    id: z.string(),
    description: z.string(),
    nodes: z.array(z.object({
      target: z.array(z.string()),
      html: z.string()
    }))
  })),
  incomplete: z.array(z.object({
    id: z.string(),
    description: z.string(),
    nodes: z.array(z.object({
      target: z.array(z.string()),
      html: z.string()
    }))
  })),
  inapplicable: z.array(z.object({
    id: z.string(),
    description: z.string()
  })),
  summary: z.object({
    total: z.number(),
    violations: z.number(),
    passes: z.number(),
    incomplete: z.number(),
    inapplicable: z.number()
  }),
  testRunner: z.object({
    name: z.string(),
    version: z.string()
  })
});

export const KeyboardTestResultSchema = z.object({
  testName: z.string(),
  passed: z.boolean(),
  interactions: z.array(z.object({
    key: z.string(),
    target: z.string(),
    expectedBehavior: z.string(),
    actualBehavior: z.string(),
    success: z.boolean(),
    timestamp: z.date()
  })),
  focusOrder: z.array(z.object({
    element: z.string(),
    tabIndex: z.number(),
    focusable: z.boolean(),
    visible: z.boolean()
  })),
  trapTests: z.array(z.object({
    container: z.string(),
    trapped: z.boolean(),
    escapeMethod: z.string().optional()
  }))
});

export const ScreenReaderTestResultSchema = z.object({
  testName: z.string(),
  passed: z.boolean(),
  announcements: z.array(z.object({
    element: z.string(),
    expectedText: z.string(),
    actualText: z.string(),
    role: z.string().optional(),
    properties: z.record(z.string()),
    success: z.boolean()
  })),
  landmarkStructure: z.array(z.object({
    type: z.string(),
    label: z.string().optional(),
    element: z.string(),
    level: z.number().optional()
  })),
  headingStructure: z.array(z.object({
    level: z.number(),
    text: z.string(),
    element: z.string()
  }))
});

export const A11yReportSchema = z.object({
  testSuite: z.string(),
  timestamp: z.date(),
  summary: z.object({
    total: z.number(),
    passed: z.number(),
    failed: z.number(),
    criticalViolations: z.number(),
    seriousViolations: z.number(),
    moderateViolations: z.number(),
    minorViolations: z.number()
  }),
  axeResults: z.array(A11yResultSchema),
  keyboardResults: z.array(KeyboardTestResultSchema),
  screenReaderResults: z.array(ScreenReaderTestResultSchema),
  environment: z.object({
    browser: z.string(),
    browserVersion: z.string(),
    platform: z.string(),
    axeVersion: z.string(),
    wcagVersion: z.string()
  })
});

// TypeScript types derived from schemas
export type A11yTestConfig = z.infer<typeof A11yTestConfigSchema>;
export type A11yViolation = z.infer<typeof A11yViolationSchema>;
export type A11yResult = z.infer<typeof A11yResultSchema>;
export type KeyboardTestResult = z.infer<typeof KeyboardTestResultSchema>;
export type ScreenReaderTestResult = z.infer<typeof ScreenReaderTestResultSchema>;
export type A11yReport = z.infer<typeof A11yReportSchema>;

// Additional interfaces for internal use
export interface A11yTestOptions {
  config: A11yTestConfig;
  outputDir: string;
  generateReport?: boolean;
  includePasses?: boolean;
  detailedResults?: boolean;
}

export interface KeyboardNavigationTest {
  name: string;
  description: string;
  selector: string;
  keys: string[];
  expectedBehavior: string;
  validation: (element: Element) => boolean;
}

export interface FocusManagementTest {
  name: string;
  selector: string;
  expectedFocusOrder: string[];
  shouldTrapFocus?: boolean;
  escapeKeys?: string[];
}

export interface AriaValidationTest {
  name: string;
  selector: string;
  expectedRole?: string;
  expectedProperties?: Record<string, string>;
  expectedStates?: Record<string, boolean>;
}

export interface ColorContrastTest {
  name: string;
  selector: string;
  expectedRatio?: number;
  level: 'AA' | 'AAA';
  fontSize?: 'normal' | 'large';
}

export interface ScreenReaderTest {
  name: string;
  selector: string;
  expectedAnnouncement: string;
  action?: 'focus' | 'click' | 'hover' | 'change';
  context?: string;
}

// Error types for accessibility testing
export class A11yTestError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: Record<string, any>
  ) {
    super(message);
    this.name = 'A11yTestError';
  }
}

export class AxeRunnerError extends A11yTestError {
  constructor(message: string, details?: Record<string, any>) {
    super(message, 'AXE_RUNNER_ERROR', details);
  }
}

export class KeyboardNavigationError extends A11yTestError {
  constructor(message: string, details?: Record<string, any>) {
    super(message, 'KEYBOARD_NAVIGATION_ERROR', details);
  }
}

export class ScreenReaderError extends A11yTestError {
  constructor(message: string, details?: Record<string, any>) {
    super(message, 'SCREEN_READER_ERROR', details);
  }
}

// Utility types for WCAG compliance
export type WcagLevel = 'A' | 'AA' | 'AAA';
export type WcagPrinciple = 'perceivable' | 'operable' | 'understandable' | 'robust';
export type ImpactLevel = 'minor' | 'moderate' | 'serious' | 'critical';

export interface WcagGuideline {
  number: string;
  title: string;
  level: WcagLevel;
  principle: WcagPrinciple;
  description: string;
  techniques: string[];
}

export interface ComplianceStatus {
  level: WcagLevel;
  passed: boolean;
  violations: A11yViolation[];
  coverage: number;
  lastTested: Date;
}